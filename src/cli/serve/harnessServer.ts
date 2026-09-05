/**
 * harnessServer — `--serve-harness` (t29, Pilastro B).
 *
 * A long-lived host for the HarnessAppServer kernel
 * (@zelari/core/harness) speaking line-delimited JSON (NDJSON) over
 * stdio, on top of the EXISTING headless protocol v2: the boot line is
 * the same `protocol_info` event `--headless` emits (version 2), and
 * while a turn runs the same BrainEvent stream is forwarded verbatim.
 *
 * Wire format (client → server requests carry `id`; server → client
 * unsolicited events carry `type` — clients demultiplex on that):
 *
 *   → {"id":1,"method":"session.create","params":{"workspaceRoot":"…"}}
 *   ← {"id":1,"ok":true,"result":{"sessionId":"…"}}
 *   → {"id":2,"method":"run.turn","params":{"sessionId":"…", …turn input
 *      same shape as a headless single turn (HeadlessOptions)}}
 *   ← {"id":2,"ok":true,"result":{"exitCode":0}}
 *   → {"id":3,"method":"session.dispose","params":{"sessionId":"…"}}
 *   ← {"id":3,"ok":true,"result":{"disposed":true}}
 *   → {"id":4,"method":"session.steer","params":{"sessionId":"…","text":"…",
 *      "controlId":"s1"}}                      (t32, protocol v2 unchanged)
 *   ← {"id":4,"ok":true,"result":{"accepted":true,"controlId":"s1",…}}
 *   ← {"type":"control_accepted","controlId":"s1","controlType":"steer",…}
 *      (unsolicited §24 acks ride the same stdout; `control_applied`
 *      arrives later, when the turn's SteeringObserver drains the queue)
 *   → {"id":5,"method":"session.cancel","params":{"sessionId":"…","reason":"…"}}
 *   ← {"id":5,"ok":true,"result":{"accepted":true,"delivered":true,…}}
 *   steer/cancel on a session with no running turn → ok:true with
 *   {"accepted":false,"outcome":"already_finished"} (explicit noop, no crash)
 *   unknown method  → {"id":n,"ok":false,"error":{"code":"unknown_method",…}}
 *   unknown session → {"id":n,"ok":false,"error":{"code":"unknown_session",…}}
 *   malformed line  → {"id":null,"ok":false,"error":{"code":"bad_json",…}}
 *                     (the server process NEVER exits on bad input)
 *
 * Error codes: bad_json · bad_request · unknown_method · unknown_session ·
 * method_failed. Malformed JSON and handler failures are contained — the
 * process keeps serving the next line.
 *
 * Ownership (the whole point of Pilastro B): the SERVER owns per-workspace
 * services (one LspManager + policy cache per resolved workspace root —
 * a second session on the same workspace does NOT respawn them) and the
 * completion-proof persistence (a client disconnect never cancels an
 * in-flight/queued proof write). The in-process stdin control plane is
 * suppressed in this mode (ZELARI_SERVE_HARNESS=1) because the transport
 * owns stdin. `--headless` remains the in-process CI client of the same
 * kernel via runOneTurn — no fork, same code path.
 */
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { HarnessAppServer } from '@zelari/core/harness';
import type {
  RunTurnFn,
  WorkspaceServices,
  WorkspaceServicesFactory,
} from '@zelari/core/harness';
import { controlAcceptedEvent, controlAppliedEvent, protocolInfoEvent } from '../headless/protocol.js';
import {
  clearSessionTurnControl,
  getLiveTurnControl,
  runWithSession,
} from './sessionControl.js';
import { resolveHeadlessKey, resolveHeadlessProvider, type HeadlessOptions } from '../headless.js';
import { dispatchHeadlessTurn } from '../runHeadless.js';
import { parseMode } from '../mode.js';
import { LspManager, type LspProvider } from '../lsp/manager.js';
import { writeCompletionProofDetailed } from '../kraken/completionProof.js';
import { setActiveProofPersistenceSurface } from '../kraken/completionProofPersist.js';
import { checkStrictPolicyLoad } from '../headless/policyGate.js';
import { activePolicyLoadMode, setActivePolicyLoadSurface } from '../safety/policyLoadMode.js';
import {
  applyTurnPermissionPreset,
  asRegistryAskHandler,
  createServePermissionBridge,
  servePermissionRespond,
} from './permissionBridge.js';
import { sweepOrphanSpineLocks } from './spineLockSweep.js';

export interface HarnessServerIo {
  input: Readable;
  output: Writable;
}

export interface StartHarnessServerOptions {
  /** Defaults to process.stdin/stdout. Injectable for in-memory tests. */
  io?: HarnessServerIo | undefined;
  /** Defaults to the real CLI turn (runOneTurn + provider resolution). */
  runTurn?: RunTurnFn | undefined;
  /** Defaults to the real CLI per-workspace services. */
  createWorkspaceServices?: WorkspaceServicesFactory | undefined;
}

interface RequestEnvelope {
  id?: number | string | null | undefined;
  method?: unknown;
  params?: Record<string, unknown> | undefined;
}

interface ResponseEnvelope {
  id: number | string | null;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

/**
 * Real per-workspace services: one LspManager anchored to the workspace,
 * the strict policy-load snapshot (cached per root by the kernel), and the
 * durable completion-proof writer (atomic tmp→fsync→rename, CLI-owned).
 */
export function createCliWorkspaceServices(workspaceRoot: string): WorkspaceServices {
  const mode = activePolicyLoadMode();
  const policyLoad = checkStrictPolicyLoad(workspaceRoot, { mode });
  // Extra host fields ride along; the kernel sees the PolicyCacheLike shape.
  const policyCache = {
    workspaceRoot,
    loadedAt: Date.now(),
    mode,
    blocked: policyLoad.blocked,
    warnings: policyLoad.warnings,
  };
  return {
    lspManager: new LspManager({ cwd: workspaceRoot }),
    policyCache,
    completionProofWriter: async (request) => {
      await writeCompletionProofDetailed(
        request.payload as unknown as Parameters<typeof writeCompletionProofDetailed>[0],
        {
          baseDir: request.baseDir,
          meta: { surface: request.surface, sessionId: request.sessionId },
        },
      );
    },
  };
}

/**
 * Bind a `run.turn` payload to HeadlessOptions, pinning the session's
 * workspaceRoot as `cwd`. Extracted so tests can prove the sidecar does
 * not silently fall back to `process.cwd()` (the 2.16.0 leak).
 */
export function bindHarnessTurnOptions(
  input: Record<string, unknown>,
  workspaceRoot: string,
): HeadlessOptions {
  const turnInput = input as Partial<HeadlessOptions>;
  if (typeof turnInput.task !== 'string' || turnInput.task.length === 0) {
    throw new Error('run.turn requires a non-empty string `task`');
  }
  // Desktop Rust historically mapped "kraken" → "agent"; the CLI parser
  // aliases agent→kraken. Sidecar JSON skipped that alias, so playbooks
  // gated on mode==='kraken' never loaded (lead-only tentacles).
  const rawMode = typeof turnInput.mode === 'string' ? turnInput.mode : 'kraken';
  const mode = (parseMode(rawMode) ?? 'kraken') as NonNullable<HeadlessOptions['mode']>;
  return {
    ...(input as unknown as Omit<HeadlessOptions, 'task' | 'mode' | 'output' | 'cwd'>),
    task: turnInput.task,
    mode,
    output: 'json',
    cwd: workspaceRoot,
    useCouncil: turnInput.useCouncil === true || mode === 'council',
  };
}

/**
 * t37 (anti-thrash): resolve the workspace-scoped LSP provider for a
 * served turn. The kernel types `WorkspaceServices.lspManager` as the
 * minimal `LspManagerLike` (`{dispose()}`) so hosts can inject fakes;
 * only a REAL LspManager carries the `LspProvider` surface the tool
 * registry needs. Anything else — including a bare `{dispose}` fake —
 * resolves to `undefined` and the turn falls back to the shared
 * per-root manager (one manager per workspace root since t37, so the
 * fallback is anti-thrash too, never a crash).
 */
export function resolveTurnLspProvider(
  services: WorkspaceServices | undefined,
): LspProvider | undefined {
  const candidate: unknown = services?.lspManager;
  return candidate instanceof LspManager ? candidate : undefined;
}

/**
 * Real turn implementation: provider/key/stream resolution happens ONCE
 * per server (mirroring runHeadless: one process, one key), then each
 * run.turn is `dispatchHeadlessTurn` — same switch as `--headless`
 * (kraken / council / zelari / graph / gauntlet), with the session
 * workspaceRoot threaded as `opts.cwd`.
 */
export function createCliRunTurn(
  onPermissionAsk?: ReturnType<typeof asRegistryAskHandler>,
): RunTurnFn {
  let streamPromise: Promise<{ provider: string; model: string; stream: unknown }> | null = null;
  const ensureStream = () => {
    if (!streamPromise) {
      streamPromise = (async () => {
        const { provider, model } = resolveHeadlessProvider({} as HeadlessOptions);
        const key = await resolveHeadlessKey(provider);
        if ('error' in key) throw new Error(key.error);
        const { buildProviderStream } = await import('../provider/resolveStream.js');
        const stream = buildProviderStream({
          providerId: provider as import('../keyStore.js').ProviderName,
          apiKey: key.apiKey,
          baseUrl: key.baseUrl,
          model,
        });
        return { provider, model, stream };
      })();
      streamPromise.catch(() => {
        streamPromise = null; // allow a retry after the key materializes
      });
    }
    return streamPromise;
  };
  return async (input, deps) => {
    const { provider, model, stream } = await ensureStream();
    const opts = bindHarnessTurnOptions(input, deps.session.workspaceRoot);
    // Serve ask-bridge: when the host registered a bridge, "ask" rules
    // become interactive (permission.request over NDJSON, deny-on-timeout)
    // instead of the fail-closed typedErr. runOneTurn threads this into
    // the tool registry.
    if (onPermissionAsk) opts.onPermissionAsk = onPermissionAsk;
    // Per-turn permission preset from Desktop Settings. Allowlisted inside
    // the bridge — unknown values keep the sidecar's current preset (no
    // arbitrary env injection over the wire).
    applyTurnPermissionPreset(input);
    // t37: thread the kernel-owned workspace LspManager into the turn so
    // the tool registry registers the LSP tools against THAT server (its
    // lifecycle is refcounted by the kernel per root) instead of deriving
    // one from the shared per-root map on every dispatch.
    const lspProvider = resolveTurnLspProvider(deps.services);
    const exitCode = await dispatchHeadlessTurn(
      opts,
      provider,
      model,
      stream as Parameters<typeof dispatchHeadlessTurn>[3],
      undefined,
      lspProvider ? { lspProvider } : undefined,
    );
    return { exitCode };
  };
}

/** Typed unknown_session envelope (shared by the session-scoped methods). */
function unknownSessionEnvelope(
  id: number | string | null,
  rawSessionId: unknown,
): ResponseEnvelope {
  return {
    id,
    ok: false,
    error: { code: 'unknown_session', message: `no session '${String(rawSessionId ?? '')}'` },
  };
}

/**
 * Boot the kernel + NDJSON transport. Injectable I/O keeps this testable
 * without spawning a process; `runHarnessServer()` below is the stdio entry.
 */
export function startHarnessServer(options: StartHarnessServerOptions = {}): {
  server: HarnessAppServer;
  close(): Promise<void>;
} {
  const io = options.io ?? { input: process.stdin, output: process.stdout };
  const server = new HarnessAppServer({
    createWorkspaceServices: options.createWorkspaceServices ?? createCliWorkspaceServices,
  });

  const write = (line: string): void => {
    try {
      io.output.write(line + '\n');
    } catch {
      /* transport is gone (EPIPE) — the kernel outlives the client */
    }
  };
  const respond = (envelope: ResponseEnvelope): void => {
    write(JSON.stringify(envelope));
  };

  // Ask-bridge: policy "ask" rules surface as permission.request events on
  // this transport and settle via the permission.respond method below.
  // Deny-on-timeout (120s) is enforced inside the bridge — an unanswered
  // request can never allow.
  const permissionBridge = createServePermissionBridge(write);

  const dispatch = async (req: RequestEnvelope): Promise<ResponseEnvelope> => {
    if (typeof req.method !== 'string') {
      return { id: req.id ?? null, ok: false, error: { code: 'bad_request', message: 'missing method' } };
    }
    const params = req.params ?? {};
    switch (req.method) {
      case 'permission.respond': {
        // Host answer to a permission.request. Shape errors come back as
        // accepted:false + reason; unknown/late ids are an idempotent
        // accepted:false no-op (never an error — the deny-timeout already
        // settled the turn).
        return {
          id: req.id ?? null,
          ok: true,
          result: servePermissionRespond(permissionBridge, params),
        };
      }
      case 'session.create': {
        const root = typeof params.workspaceRoot === 'string' ? params.workspaceRoot : process.cwd();
        // asRegistryAskHandler projects the registry ask payload onto the
        // wire payload (tool/categories/claims → dialog preview).
        const session = server.createSession({
          workspaceRoot: root,
          runTurn: options.runTurn ?? createCliRunTurn(asRegistryAskHandler(permissionBridge)),
        });
        return { id: req.id ?? null, ok: true, result: { sessionId: session.id, workspaceRoot: session.workspaceRoot } };
      }
      case 'run.turn': {
        const session = server.getSession(String(params.sessionId ?? ''));
        if (!session) {
          return { id: req.id ?? null, ok: false, error: { code: 'unknown_session', message: `no session '${String(params.sessionId ?? '')}'` } };
        }
        const { sessionId: _ignored, ...turnInput } = params;
        // t32: carry the session id into runOneTurn's control-plane
        // registration via async context (same call-chain, no new
        // HeadlessOptions field). Settlement cleanup drops the registration
        // even on a crash path, so later steers get the honest
        // already_finished noop instead of targeting a dead queue.
        const result = await runWithSession(session.id, async () => {
          try {
            return await session.runTurn(turnInput);
          } finally {
            clearSessionTurnControl(session.id);
          }
        });
        return { id: req.id ?? null, ok: true, result };
      }
      case 'session.dispose': {
        const session = server.getSession(String(params.sessionId ?? ''));
        if (!session) {
          return { id: req.id ?? null, ok: false, error: { code: 'unknown_session', message: `no session '${String(params.sessionId ?? '')}'` } };
        }
        await session.dispose();
        return { id: req.id ?? null, ok: true, result: { disposed: true } };
      }
      // t32: session-scoped steer/cancel over the SAME protocol v2 — no new
      // protocol version, same §24 ack events the stdin bridge emits.
      case 'session.steer':
      case 'session.cancel': {
        const isCancel = req.method === 'session.cancel';
        const session = server.getSession(String(params.sessionId ?? ''));
        if (!session) {
          return unknownSessionEnvelope(req.id ?? null, params.sessionId);
        }
        const controlId =
          typeof params.controlId === 'string' && params.controlId.length > 0
            ? params.controlId
            : `ctrl-${randomUUID()}`;
        const controlType = isCancel ? 'cancel' : 'steer';
        // Shape validation BEFORE state checks: a malformed control is a
        // bad_request regardless of session/turn state (same shape rule as
        // the stdin control reader, controlReader.ts).
        const text = params.text;
        if (!isCancel && (typeof text !== 'string' || text.trim().length === 0)) {
          return {
            id: req.id ?? null,
            ok: false,
            error: { code: 'bad_request', message: 'session.steer requires a non-empty string `text`' },
          };
        }
        const live = getLiveTurnControl(session.id);
        if (!live) {
          // Known session, but no turn is running (never started, already
          // completed or cancelled): EXPLICIT noop result — never a crash,
          // never a fake acceptance (§24: never pretend a control applied).
          return {
            id: req.id ?? null,
            ok: true,
            result: { accepted: false, outcome: 'already_finished', controlId, controlType },
          };
        }
        if (isCancel) {
          // Nothing drains cancel events mid-run, so application goes
          // through the cooperative harness cancel hook directly; the queue
          // never holds an undrainable cancel.
          const delivered = live.cancel();
          if (delivered) {
            write(JSON.stringify(controlAppliedEvent(controlId, 'cancel', 'cancel')));
          }
          return {
            id: req.id ?? null,
            ok: true,
            result: { accepted: true, delivered, controlId, controlType },
          };
        }
        // §24: enqueue = accepted; the control_applied ack (boundary
        // turn-end) is emitted by the turn when SteeringObserver drains.
        live.queue.enqueue({ type: 'steer', id: controlId, text: text as string, ts: Date.now() });
        write(JSON.stringify(controlAcceptedEvent(controlId, 'steer')));
        return {
          id: req.id ?? null,
          ok: true,
          result: { accepted: true, controlId, controlType, boundary: 'turn-end' },
        };
      }
      default:
        return {
          id: req.id ?? null,
          ok: false,
          error: { code: 'unknown_method', message: `unsupported method '${req.method}'` },
        };
    }
  };

  const rl = createInterface({ input: io.input });
  // Boot handshake — same protocol_info envelope/version as `--headless`.
  write(JSON.stringify(protocolInfoEvent()));
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let req: RequestEnvelope;
    try {
      req = JSON.parse(trimmed) as RequestEnvelope;
      if (req === null || typeof req !== 'object') throw new Error('not an object');
    } catch (err) {
      respond({
        id: null,
        ok: false,
        error: {
          code: 'bad_json',
          message: `malformed JSON line skipped: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
      return; // server keeps running (DoD e)
    }
    void dispatch(req).then(
      (envelope) => respond(envelope),
      (err) =>
        respond({
          id: (req.id ?? null) as number | string | null,
          ok: false,
          error: {
            code: 'method_failed',
            message: err instanceof Error ? err.message : String(err),
          },
        }),
    );
  });

  return {
    server,
    close(): Promise<void> {
      // Kernel teardown FIRST-class: pending completion-proof writes are
      // awaited (never cancelled) before services die.
      rl.close();
      io.input.pause();
      return server.dispose();
    },
  };
}

/** Process entry for `--serve-harness`: stdio transport + host pre-flight. */
export async function runHarnessServer(): Promise<void> {
  // Same host registration runHeadless performs before any registry exists.
  setActivePolicyLoadSurface('headless');
  setActiveProofPersistenceSurface('headless');
  // Boot sweep: a crashed host leaves writer.lock orphans behind; delete the
  // provably-orphaned ones (dead pid / heartbeat-stale / >10 min stale) so
  // the next resume acquires cleanly instead of silently degrading.
  // Best-effort — a sweep failure NEVER blocks the sidecar boot.
  try {
    await sweepOrphanSpineLocks();
  } catch {
    /* boot must not depend on the sweep */
  }
  // runOneTurn checks this to keep its paws off stdin (transport-owned).
  process.env.ZELARI_SERVE_HARNESS = '1';
  const started = startHarnessServer();
  await new Promise<void>((resolvePromise) => {
    const finish = () => void started.close().then(() => resolvePromise());
    process.stdin.once('end', finish);
    process.stdin.once('close', finish);
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
}
