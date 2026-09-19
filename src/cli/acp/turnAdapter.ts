/**
 * acp/turnAdapter — the ONLY place where ACP touches the agent runtime.
 *
 * A turn is dispatched through the EXISTING headless path
 * (`dispatchHeadlessTurn`, src/cli/runHeadless.ts) — same switch as
 * `--headless` / `--serve-harness` (kraken / council / zelari / graph), no
 * second agent loop. The adapter is thin and honest about its two seams:
 *
 * 1. STDOUT CAPTURE. `dispatchHeadlessTurn` streams its events to
 *    `process.stdout` (NDJSON when `output: 'json'`, via headless.ts
 *    `emitEvent`). stdout is the ACP transport here, so the adapter captures
 *    `process.stdout.write` for the duration of the turn and projects each
 *    captured line through eventMap.ts. ACP frames are unaffected: the frame
 *    writer bound `process.stdout.write` BEFORE any capture (framing.ts).
 *    Turns are therefore SERIALIZED process-wide (single in-flight capture) —
 *    a prompt for a second session waits for the first turn to finish.
 *
 * 2. STDIN OWNERSHIP. With `output: 'json'` and piped stdin, runOneTurn
 *    attaches the in-process headless CONTROL PLANE reader on stdin
 *    (headless/runOneTurn.ts, headless/liveTurnAbort.ts). That reader would
 *    eat ACP frames. The repo's documented escape hatch for a host that owns
 *    stdin is `ZELARI_SERVE_HARNESS=1` (exactly why `--serve-harness` sets
 *    it); the adapter sets it for the turn and restores the prior value.
 *
 * The turn is ASYNC and never blocks the JSON-RPC loop (server.ts resolves the
 * pending `session/prompt` response later). `signal` is checked before the
 * turn starts; a cancel that lands mid-turn resolves the protocol response and
 * the remaining updates are dropped by the server (see protocol.ts header).
 */
import type { HeadlessOptions } from '../headless.js';
import {
  drainLines,
  mapCapturedLine,
  type LineBuffer,
} from './eventMap.js';
import { agentMessageChunk, type SessionUpdate, type StopReason } from './protocol.js';
import { ACP_ERROR_CODES } from './invariants.js';

export interface AcpTurnRequest {
  sessionId: string;
  cwd: string;
  prompt: string;
  onUpdate: (update: SessionUpdate) => void;
  signal: AbortSignal;
}

export interface AcpTurnResult {
  stopReason: StopReason;
  /** Exit code of the underlying headless turn (diagnostics/tests). */
  exitCode: number;
}

export type AcpTurnDispatcher = (request: AcpTurnRequest) => Promise<AcpTurnResult>;

export interface ProviderStreamResolution {
  provider: string;
  model: string;
  stream: unknown;
}

export interface HeadlessTurnDeps {
  /** Injectable turn runner. Defaults to the real `dispatchHeadlessTurn`. */
  dispatch?: (
    opts: HeadlessOptions,
    provider: string,
    model: string,
    stream: unknown,
  ) => Promise<number>;
  /** Injectable provider/key/stream resolution (tests inject a fake stream). */
  resolveStream?: () => Promise<ProviderStreamResolution>;
  /** `--provider` flag (default: the active provider from provider.json). */
  provider?: string;
  /** `--model` flag (default: the provider's configured model). */
  model?: string;
  /** Dispatch mode (default 'kraken' — the CLI's default single-agent mode). */
  mode?: 'kraken' | 'council' | 'zelari';
}

/** Swap `process.stdout.write` for the duration of a turn. Returns restore. */
export function captureStdout(onChunk: (chunk: string) => void): () => void {
  const original = process.stdout.write;
  const patched = ((chunk: unknown, ...rest: unknown[]): boolean => {
    try {
      const text =
        typeof chunk === 'string'
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString('utf8')
            : String(chunk);
      onChunk(text);
    } catch {
      /* a capture bug must never kill the turn */
    }
    // Callers (e.g. content builders) may pass a completion callback; honour it
    // so nothing can hang waiting on a write that "succeeded".
    const last = rest[rest.length - 1];
    if (typeof last === 'function') {
      try {
        (last as () => void)();
      } catch {
        /* ignore */
      }
    }
    return true;
  }) as unknown as typeof process.stdout.write;
  process.stdout.write = patched;
  return () => {
    process.stdout.write = original;
  };
}

/**
 * Serialize turn execution: the stdout capture is process-global, so exactly
 * one turn may be in flight. Later prompts queue behind earlier ones.
 */
function createSingleFlight(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/** Real dispatcher: lazy provider resolution + stdout capture, serialized. */
export function createHeadlessTurnDispatcher(deps: HeadlessTurnDeps = {}): AcpTurnDispatcher {
  const enqueue = createSingleFlight();
  const mode = deps.mode ?? 'kraken';
  let streamPromise: Promise<ProviderStreamResolution> | null = null;

  const ensureStream = (): Promise<ProviderStreamResolution> => {
    if (!streamPromise) {
      streamPromise = (async () => {
        if (deps.resolveStream) return deps.resolveStream();
        // Dynamic imports keep the TUI/provider graph out of the module load
        // path until a turn actually needs it (same discipline as runHeadless).
        const { resolveHeadlessKey, resolveHeadlessProvider } = await import('../headless.js');
        const { provider, model } = resolveHeadlessProvider({
          ...(deps.provider ? { provider: deps.provider } : {}),
          ...(deps.model ? { model: deps.model } : {}),
        } as HeadlessOptions);
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
        streamPromise = null; // allow a retry once the key materializes
      });
    }
    return streamPromise;
  };

  const runTurn = deps.dispatch ?? defaultDispatch;

  return (request) =>
    enqueue(async (): Promise<AcpTurnResult> => {
      if (request.signal.aborted) return { stopReason: 'cancelled', exitCode: 0 };
      const { provider, model, stream } = await ensureStream();
      const opts: HeadlessOptions = {
        task: request.prompt,
        output: 'json',
        mode,
        phase: 'build',
        useCouncil: mode === 'council',
        cwd: request.cwd,
      };

      const buffer: LineBuffer = { text: '' };
      const emit = (line: string): void => {
        for (const update of mapCapturedLine(line)) request.onUpdate(update);
      };
      const restore = captureStdout((chunk) => {
        buffer.text += chunk;
        drainLines(buffer, false, emit);
      });
      const priorHostMarker = process.env['ZELARI_SERVE_HARNESS'];
      process.env['ZELARI_SERVE_HARNESS'] = '1';

      let exitCode = 2;
      try {
        exitCode = await runTurn(opts, provider, model, stream);
      } catch (err) {
        request.onUpdate(
          agentMessageChunk(
            `\n[zelari-code acp] ${ACP_ERROR_CODES.TURN_FAILED}: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        exitCode = 2;
      } finally {
        if (priorHostMarker === undefined) delete process.env['ZELARI_SERVE_HARNESS'];
        else process.env['ZELARI_SERVE_HARNESS'] = priorHostMarker;
        restore();
        drainLines(buffer, true, emit);
      }

      return {
        stopReason: request.signal.aborted ? 'cancelled' : stopReasonForExit(exitCode),
        exitCode,
      };
    });
}

/**
 * Headless exit codes (headless.ts header): 0 completed, 1 user error,
 * 2 runtime error, 3 agent errored, 5/6 strict evidence gates. ACP only has
 * `end_turn | max_tokens | refusal | cancelled`; every non-zero outcome is
 * reported as `refusal` (the turn did not deliver) — the exit code travels
 * with AcpTurnResult for hosts that log it.
 */
function stopReasonForExit(exitCode: number): StopReason {
  return exitCode === 0 ? 'end_turn' : 'refusal';
}

/** Default turn runner — the real headless dispatch (imported lazily). */
async function defaultDispatch(
  opts: HeadlessOptions,
  provider: string,
  model: string,
  stream: unknown,
): Promise<number> {
  const { dispatchHeadlessTurn } = await import('../runHeadless.js');
  return dispatchHeadlessTurn(
    opts,
    provider,
    model,
    stream as Parameters<typeof dispatchHeadlessTurn>[3],
  );
}
