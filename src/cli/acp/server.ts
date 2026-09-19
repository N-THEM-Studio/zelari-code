/**
 * acp/server — the stdio JSON-RPC 2.0 loop behind `zelari-code acp`.
 *
 * Responsibilities (and nothing else): decode frames, route methods, keep the
 * loop NON-BLOCKING while a turn runs, translate failures into JSON-RPC
 * errors, shut down cleanly on EOF. The agent runtime itself lives behind the
 * injected `AcpTurnDispatcher` (turnAdapter.ts) — this module has no opinion
 * about how a turn is executed, which keeps its tests model-free.
 *
 * Fail-soft invariants (P2), each covered by a test:
 *   - malformed frame  -> reported to `log` (stderr), loop continues;
 *   - unknown method   -> -32601, loop continues;
 *   - bad params       -> -32602, loop continues;
 *   - internal throw   -> -32603, loop continues (process stays alive);
 *   - stdin EOF/error  -> in-flight prompts settle as 'cancelled', reader
 *                         detaches, `onShutdown` fires once (exit 0 upstream).
 *
 * Protocol subset + explicit non-goals: see the header of protocol.ts.
 */
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { attachFrameReader, createFrameWriter, type FrameSink } from './framing.js';
import {
  ACP_ERROR_CODES,
  AcpError,
  JSON_RPC_ERRORS,
  parseJsonRpcMessage,
  readInitializeParams,
  readPromptParams,
  readSessionIdParams,
  readSessionNewParams,
  sessionUpdateNotification,
  type AcpErrorCode,
  type JsonRpcId,
  type SessionUpdate,
  type StopReason,
} from './protocol.js';
import { createTurnStream, type TurnStream } from './invariants.js';
import type { AcpTurnDispatcher, AcpTurnResult } from './turnAdapter.js';

/** Agent capabilities advertised on `initialize` (no reverse requests). */
export const ACP_AGENT_CAPABILITIES = {
  loadSession: false,
  promptCapabilities: { image: false, audio: false, embeddedContext: false },
} as const;

export interface AcpServerDeps {
  /** Turn executor. Tests inject a fake; command.ts injects the headless one. */
  dispatcher: AcpTurnDispatcher;
  /** Transport input. Defaults to `process.stdin`. */
  input?: Readable;
  /** Transport output. Defaults to `process.stdout`. */
  output?: FrameSink;
  /** Diagnostics (stderr). Defaults to `process.stderr.write`. */
  log?: (line: string) => void;
  /** `--cwd` flag: fallback when a client opens a session without a cwd. */
  fallbackCwd?: string;
  /** Called ONCE when the transport is over (EOF, stdin error, close()). */
  onShutdown?: () => void;
}

export interface AcpServerHandle {
  /** Ids of the sessions opened so far (inspection/tests). */
  sessionIds(): string[];
  /** Cancel in-flight work + detach the reader. Idempotent. */
  close(): void;
  /** Resolves after the transport has shut down. */
  whenClosed(): Promise<void>;
}

interface InflightRecord {
  cancelled: boolean;
  settled: boolean;
  abort: AbortController;
  /** Invariant 1 state for THIS turn: one stream, exactly one terminal frame. */
  stream: TurnStream;
  settle(result: { stopReason: StopReason }): void;
}

interface SessionState {
  id: string;
  cwd: string;
  inflight?: InflightRecord;
}

type MethodOutcome =
  | { kind: 'result'; value: unknown }
  | { kind: 'pending'; promise: Promise<unknown> };

function resultResponse(id: JsonRpcId, result: unknown): unknown {
  return { jsonrpc: '2.0', id, result };
}

/**
 * Invariant 3 at the emit site: every error frame carries the numeric code the
 * spec requires AND the stable string code from ACP_ERROR_CODES (in
 * `error.data.code`), so a client never parses a message to branch on a
 * failure. The two are built from the same error object (`errorCodeOf` below).
 */
function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  errorCode: AcpErrorCode,
): unknown {
  return { jsonrpc: '2.0', id, error: { code, message, data: { code: errorCode } } };
}

function errorCodeOf(err: unknown): number {
  return err instanceof AcpError ? err.code : JSON_RPC_ERRORS.INTERNAL_ERROR;
}

/** Stable string code for the same error (invariant 3; never a message). */
function stringErrorCodeOf(err: unknown): AcpErrorCode {
  return err instanceof AcpError ? err.errorCode : ACP_ERROR_CODES.INTERNAL_ERROR;
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Start the ACP transport on the given (or process) stdio pair. */
export function startAcpServer(deps: AcpServerDeps): AcpServerHandle {
  const input = deps.input ?? process.stdin;
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const sessions = new Map<string, SessionState>();
  let closed = false;

  // The frame writer binds sink.write NOW (framing.ts): a turn's stdout
  // capture (turnAdapter.ts) can never swallow a JSON-RPC frame.
  const writer = createFrameWriter(deps.output ?? process.stdout, (message) =>
    log(`[zelari-code acp] stdout write failed: ${message}`),
  );

  const shutdownWaiters: Array<() => void> = [];
  const reader = attachFrameReader(input, {
    onMessage: (raw) => {
      void handleMessage(raw);
    },
    onEof: () => shutdown(),
    onMalformedFrame: (detail) => log(`[zelari-code acp] frame dropped (fail-soft): ${detail}`),
  });

  function shutdown(): void {
    if (closed) return;
    closed = true;
    for (const session of sessions.values()) cancelPrompt(session);
    reader.detach();
    for (const waiter of shutdownWaiters.splice(0)) waiter();
    try {
      deps.onShutdown?.();
    } catch {
      /* shutdown is best-effort */
    }
  }

  function cancelPrompt(session: SessionState): void {
    const inflight = session.inflight;
    if (!inflight) return;
    inflight.cancelled = true;
    try {
      inflight.abort.abort();
    } catch {
      /* ignore */
    }
    inflight.settle({ stopReason: 'cancelled' });
  }

  async function handleMessage(raw: unknown): Promise<void> {
    const parsed = parseJsonRpcMessage(raw);
    if (parsed.kind === 'invalid') {
      writer.write(
        errorResponse(
          parsed.id,
          JSON_RPC_ERRORS.INVALID_REQUEST,
          parsed.reason,
          ACP_ERROR_CODES.INVALID_REQUEST,
        ),
      );
      return;
    }
    if (parsed.kind === 'notification') {
      handleNotification(parsed.notification.method, parsed.notification.params);
      return;
    }
    const { id, method, params } = parsed.request;
    let outcome: MethodOutcome;
    try {
      outcome = handleRequest(method, params);
    } catch (err) {
      writer.write(errorResponse(id, errorCodeOf(err), errorMessageOf(err), stringErrorCodeOf(err)));
      return;
    }
    if (outcome.kind === 'result') {
      writer.write(resultResponse(id, outcome.value));
      return;
    }
    // Pending (a turn is running): the loop keeps reading stdin while the
    // response is written when the dispatcher settles.
    outcome.promise.then(
      (value) => writer.write(resultResponse(id, value)),
      (err) =>
        writer.write(
          errorResponse(id, errorCodeOf(err), errorMessageOf(err), stringErrorCodeOf(err)),
        ),
    );
  }

  /** Inbound notifications are never answered (JSON-RPC 2.0). */
  function handleNotification(method: string, params: unknown): void {
    try {
      if (method === 'initialized') return; // handshake tail: nothing to do
      if (method === 'session/cancel') {
        const { sessionId } = readSessionIdParams(params, 'session/cancel');
        const session = sessions.get(sessionId);
        if (!session) {
          log(`[zelari-code acp] session/cancel for unknown session '${sessionId}'`);
          return;
        }
        cancelPrompt(session);
        return;
      }
      if (method === '$/cancelRequest') return; // acknowledged, no-op
      log(`[zelari-code acp] ignoring unknown notification '${method}'`);
    } catch (err) {
      log(`[zelari-code acp] notification '${method}' rejected: ${errorMessageOf(err)}`);
    }
  }

  function handleRequest(method: string, params: unknown): MethodOutcome {
    switch (method) {
      case 'initialize': {
        const { protocolVersion } = readInitializeParams(params);
        return {
          kind: 'result',
          value: {
            protocolVersion,
            agentCapabilities: ACP_AGENT_CAPABILITIES,
            authMethods: [],
          },
        };
      }
      case 'session/new': {
        const { cwd } = readSessionNewParams(params, deps.fallbackCwd);
        const sessionId = randomUUID();
        sessions.set(sessionId, { id: sessionId, cwd });
        return { kind: 'result', value: { sessionId } };
      }
      case 'session/prompt': {
        const { sessionId, text } = readPromptParams(params);
        const session = sessions.get(sessionId);
        if (!session) {
          throw new AcpError(JSON_RPC_ERRORS.INVALID_PARAMS, `unknown session '${sessionId}'`);
        }
        if (session.inflight) {
          throw new AcpError(
            JSON_RPC_ERRORS.INVALID_PARAMS,
            `session '${sessionId}' already has a prompt in flight`,
          );
        }
        return { kind: 'pending', promise: startPrompt(session, text) };
      }
      case 'session/cancel': {
        const { sessionId } = readSessionIdParams(params, 'session/cancel');
        const session = sessions.get(sessionId);
        if (!session) {
          throw new AcpError(JSON_RPC_ERRORS.INVALID_PARAMS, `unknown session '${sessionId}'`);
        }
        cancelPrompt(session);
        return { kind: 'result', value: null };
      }
      default:
        throw new AcpError(JSON_RPC_ERRORS.METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }

  function startPrompt(session: SessionState, text: string): Promise<{ stopReason: StopReason }> {
    // One stream per turn (invariants.ts): every frame and the single terminal
    // frame go through it, so a late or over-cap frame is dropped loudly.
    const stream = createTurnStream(session.id, log);
    const record: InflightRecord = {
      cancelled: false,
      settled: false,
      abort: new AbortController(),
      stream,
      settle: () => {},
    };
    const promise = new Promise<{ stopReason: StopReason }>((resolve) => {
      record.settle = (result) => {
        if (record.settled) return;
        record.settled = true;
        // INVARIANT 1: the `session/prompt` response IS this turn's terminal
        // frame — recorded here, once, on every path that ends the turn
        // (dispatcher result, dispatcher rejection, cancel, EOF shutdown).
        stream.terminate(result.stopReason);
        resolve(result);
      };
    });
    session.inflight = record;

    const onUpdate = (update: SessionUpdate): void => {
      // A cancelled turn stops streaming: the client was already told so.
      if (record.cancelled) return;
      // INVARIANTS 1+2: nothing is emitted after the terminal frame, and a
      // payload that was clamped without saying so never reaches the wire.
      if (!stream.push(update)) return;
      writer.write(sessionUpdateNotification(session.id, update));
    };

    // A dispatcher that throws SYNCHRONOUSLY must still terminate this turn:
    // otherwise `session.inflight` would stay set forever (the session could
    // never be prompted again) with no terminal frame on the wire.
    let running: Promise<AcpTurnResult>;
    try {
      running = deps.dispatcher({
        sessionId: session.id,
        cwd: session.cwd,
        prompt: text,
        onUpdate,
        signal: record.abort.signal,
      });
    } catch (err) {
      running = Promise.reject(err);
    }

    void running
      .then(
        (result) => record.settle({ stopReason: record.cancelled ? 'cancelled' : result.stopReason }),
        (err) => {
          log(`[zelari-code acp] ${ACP_ERROR_CODES.TURN_FAILED}: ${errorMessageOf(err)}`);
          record.settle({ stopReason: record.cancelled ? 'cancelled' : 'refusal' });
        },
      )
      .finally(() => {
        if (session.inflight === record) session.inflight = undefined;
        // The turn is over: exactly one terminal frame must have been
        // recorded (unreachable today — `settle` above always terminates —
        // this is the guard that keeps it unreachable).
        stream.close();
      });

    return promise;
  }

  return {
    sessionIds: () => [...sessions.keys()],
    close: () => shutdown(),
    whenClosed: () =>
      closed
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            shutdownWaiters.push(resolve);
          }),
  };
}
