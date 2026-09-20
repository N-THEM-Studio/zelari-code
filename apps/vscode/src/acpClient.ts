/**
 * acpClient — the PURE protocol client for the ACP stdio front door.
 *
 * Two-layer architecture (the extension is deliberately split):
 *   (a) THIS module + ndjson.ts + protocol.ts + acpTransport.ts have ZERO
 *       `vscode` imports and are unit-tested by vitest without any extension
 *       host: framing, request/response correlation by id, notification
 *       fan-out and shutdown semantics are all provable in plain Node.
 *   (b) extension.ts is the thin adapter (commands, OutputChannel, status
 *       bar). All of the protocol risk sits in (a).
 *
 * Design rules that the tests pin down:
 *   - ONE turn at a time (the server refuses a second in-flight prompt),
 *     correlation by JSON-RPC id, never by arrival order;
 *   - a closed session rejects EVERY pending request and can never emit a
 *     terminal event twice (the first reason wins: `shutdown` | `exit` | `end`
 *     | `error`), the client-side mirror of the server's terminal-frame
 *     invariant;
 *   - a listener/handler that throws is contained and logged: a broken UI
 *     callback must never kill the protocol loop.
 */
import { createNdjsonDecoder, encodeNdjson } from './ndjson.js';
import {
  ACP_METHODS,
  ACP_NOTIFICATIONS,
  ACP_PROTOCOL_VERSION,
  isSessionUpdateParams,
  type AcpInitializeResult,
  type AcpSessionUpdateParams,
  type AcpNewSessionResult,
  type AcpPromptResult,
  type StopReason,
} from './protocol.js';
import {
  AcpClientClosedError,
  AcpProtocolError,
  AcpResponseError,
  type AcpCloseInfo,
  type AcpDisposable,
  type AcpExitInfo,
  type AcpNotification,
  type AcpTransport,
} from './acpTransport.js';

/**
 * The event map: each key is an event, each value is its PAYLOAD. `on()`
 * derives the handler signature from it, so a listener can never be handed the
 * wrong shape.
 */
export interface AcpClientEventPayloads {
  /** One `session/update` notification — the message + tool-call stream. */
  update: AcpSessionUpdateParams;
  /** Any other notification (none in the served subset today). */
  notification: AcpNotification;
  /** Agent stderr line (diagnostics; never protocol). */
  stderr: string;
  /** The agent process exited. Always emitted for a real process, even after `closed`. */
  exit: AcpExitInfo;
  /** First terminal event: from here on the client is unusable. Exactly once. */
  closed: AcpCloseInfo;
}

export type AcpClientEvent = keyof AcpClientEventPayloads;

export type AcpClientListener<E extends AcpClientEvent> = (
  payload: AcpClientEventPayloads[E],
) => void;

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(reason: Error): void;
}

/** An erased listener slot: the event map is the type-level contract. */
type StoredListener = (payload: never) => void;

export type AcpLogFn = (line: string) => void;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function preview(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= 80 ? flat : `${flat.slice(0, 80)}…`;
}

/** Map a JSON-RPC error object onto both codes (numeric + stable string). */
function toResponseError(method: string, error: unknown): AcpResponseError {
  const e = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const jsonRpcCode = typeof e['code'] === 'number' ? e['code'] : -32603;
  const message = typeof e['message'] === 'string' ? e['message'] : `the agent rejected ${method}`;
  const data = typeof e['data'] === 'object' && e['data'] !== null ? (e['data'] as Record<string, unknown>) : {};
  const errorCode = typeof data['code'] === 'string' ? data['code'] : 'internal_error';
  return new AcpResponseError(jsonRpcCode, message, errorCode);
}

export class AcpClient {
  readonly #transport: AcpTransport;
  readonly #log: AcpLogFn;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #listeners = new Map<AcpClientEvent, Set<StoredListener>>();
  readonly #decoder = createNdjsonDecoder();
  #nextId = 1;
  #killed = false;
  #closed: AcpCloseInfo | undefined;

  constructor(transport: AcpTransport, log: AcpLogFn = () => {}) {
    this.#transport = transport;
    this.#log = log;
    // Subscribe synchronously: the transport may hold pre-subscription values,
    // but the same-tick contract keeps the window closed anyway.
    transport.onData((chunk) => this.#onChunk(chunk));
    transport.onEnd(() => {
      this.#flushDecoder();
      this.#finish({ reason: 'end', code: null, signal: null });
    });
    transport.onExit((code, signal) => {
      this.#emit('exit', { code, signal });
      this.#finish({ reason: 'exit', code, signal });
    });
    transport.onError((error) => {
      this.#log(`transport error: ${error.message}`);
      this.#finish({ reason: 'error', code: null, signal: null, message: error.message });
    });
    transport.onStderr((line) => this.#emit('stderr', line));
  }

  get closed(): boolean {
    return this.#closed !== undefined;
  }

  /** Why/how the session ended, or `undefined` while it is alive. */
  get closeInfo(): AcpCloseInfo | undefined {
    return this.#closed;
  }

  /** Subscribe to a lifecycle event. Listener errors are contained. */
  on<E extends AcpClientEvent>(event: E, listener: AcpClientListener<E>): AcpDisposable {
    const stored = listener as unknown as StoredListener;
    const set = this.#listeners.get(event) ?? new Set<StoredListener>();
    set.add(stored);
    this.#listeners.set(event, set);
    return {
      dispose: () => {
        set.delete(stored);
      },
    };
  }

  /**
   * Send a request and await its response. The generic is a DECLARATION, not
   * a validation (JSON-RPC is schema-less on the wire): the typed helpers
   * below (`initialize`/`newSession`/`prompt`) validate the fields they use.
   */
  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.#closed !== undefined) {
      return Promise.reject(
        new AcpClientClosedError(`cannot call '${method}': the session is closed`),
      );
    }
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(String(id), { method, resolve: (value) => resolve(value as T), reject });
      this.#write({ jsonrpc: '2.0', id, method, params: params ?? {} });
    });
  }

  /** Fire-and-forget notification (no response expected, per JSON-RPC 2.0). */
  notify(method: string, params?: unknown): void {
    if (this.#closed !== undefined) {
      this.#log(`dropped notification '${method}': the session is closed`);
      return;
    }
    this.#write({ jsonrpc: '2.0', method, params: params ?? {} });
  }

  /** `initialize` + the `initialized` tail the spec expects from a client. */
  async initialize(
    params: Record<string, unknown> = { protocolVersion: ACP_PROTOCOL_VERSION },
  ): Promise<AcpInitializeResult> {
    const result = await this.request<AcpInitializeResult>(ACP_METHODS.initialize, params);
    if (typeof result?.protocolVersion !== 'number') {
      throw new AcpProtocolError('initialize returned no numeric protocolVersion');
    }
    this.notify(ACP_NOTIFICATIONS.initialized);
    return result;
  }

  /** Open a session; `cwd` is the workspace the agent runs in. */
  async newSession(cwd?: string): Promise<string> {
    const result = await this.request<AcpNewSessionResult>(
      ACP_METHODS.sessionNew,
      cwd === undefined ? {} : { cwd },
    );
    const sessionId = result?.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new AcpProtocolError('session/new returned no sessionId');
    }
    return sessionId;
  }

  /**
   * Run one turn. Resolves when the turn ends (`stopReason`); the streaming
   * updates arrive through `update` meanwhile — the server does not block the
   * loop, and neither does this client.
   */
  async prompt(sessionId: string, text: string): Promise<StopReason> {
    const result = await this.request<AcpPromptResult>(ACP_METHODS.sessionPrompt, {
      sessionId,
      prompt: [{ type: 'text', text }],
    });
    const stopReason = result?.stopReason;
    if (typeof stopReason !== 'string' || stopReason.length === 0) {
      throw new AcpProtocolError('session/prompt returned no stopReason');
    }
    return stopReason as StopReason;
  }

  /** Ask the agent to drop the in-flight turn (answered with the current turn's terminal frame). */
  async cancel(sessionId: string): Promise<void> {
    await this.request<null>(ACP_METHODS.sessionCancel, { sessionId });
  }

  /**
   * GRACEFUL close: close the agent's stdin (EOF is the CLI's clean-shutdown
   * signal: `zelari-code acp` exits 0), then reject every pending request and
   * emit `closed` once. `{ kill: true }` also signals the process
   * immediately (the extension's fallback when EOF does not end it in time).
   */
  shutdown(options: { kill?: boolean } = {}): void {
    if (this.#closed !== undefined) {
      if (options.kill === true) this.#kill();
      return;
    }
    try {
      this.#transport.endInput();
    } catch (err) {
      this.#log(`closing stdin failed: ${messageOf(err)}`);
    }
    if (options.kill === true) this.#kill();
    this.#finish({ reason: 'shutdown', code: null, signal: null });
  }

  /** Hard stop. Idempotent: the transport sees at most one signal. */
  kill(): void {
    this.#kill();
  }

  #kill(): void {
    if (this.#killed) return;
    this.#killed = true;
    try {
      this.#transport.kill();
    } catch (err) {
      this.#log(`kill failed: ${messageOf(err)}`);
    }
  }

  #write(message: unknown): void {
    try {
      this.#transport.write(encodeNdjson(message));
    } catch (err) {
      this.#log(`write failed: ${messageOf(err)}`);
    }
  }

  #onChunk(chunk: string): void {
    const decoded = this.#decoder.push(chunk);
    this.#handleDecoded(decoded);
  }

  /** EOF salvage: a last line missing its newline is still decoded (as the server does). */
  #flushDecoder(): void {
    this.#handleDecoded(this.#decoder.flush());
  }

  #handleDecoded(decoded: { messages: unknown[]; warnings: string[] }): void {
    for (const warning of decoded.warnings) this.#log(`frame dropped (fail-soft): ${warning}`);
    for (const message of decoded.messages) this.#handleMessage(message);
  }

  #handleMessage(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      this.#log(`dropped a non-object frame: ${preview(raw)}`);
      return;
    }
    const message = raw as Record<string, unknown>;
    const method = message['method'];

    if (typeof method === 'string') {
      if (message['id'] !== undefined) {
        // The served subset has no agent -> client requests (see protocol.ts):
        // answering one would invent protocol.
        this.#log(`ignored agent request '${method}': the ACP subset has no reverse requests`);
        return;
      }
      const params = message['params'];
      if (method === ACP_NOTIFICATIONS.sessionUpdate && isSessionUpdateParams(params)) {
        this.#emit('update', params);
        return;
      }
      this.#emit('notification', { method, params });
      return;
    }

    const id = message['id'];
    if (id === undefined) {
      this.#log(`dropped a frame with neither method nor id: ${preview(message)}`);
      return;
    }
    const pending = this.#pending.get(String(id));
    if (pending === undefined) {
      this.#log(`dropped a response for unknown id ${String(id)}`);
      return;
    }
    this.#pending.delete(String(id));
    const error = message['error'];
    if (error !== undefined) {
      pending.reject(toResponseError(pending.method, error));
      return;
    }
    pending.resolve(message['result']);
  }

  /**
   * The ONE terminal transition. First reason wins; pending requests are
   * rejected BEFORE `closed` is emitted, so a listener observes a settled
   * client. Re-entrant calls (a child that fires `end` then `exit`) are no-ops.
   */
  #finish(info: AcpCloseInfo): void {
    if (this.#closed !== undefined) return;
    this.#closed = info;
    const rejection = new AcpClientClosedError(
      `session closed (${info.reason}${info.code === null ? '' : `, code ${info.code}`})`,
    );
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.reject(rejection);
    }
    this.#emit('closed', info);
  }

  #emit<E extends AcpClientEvent>(event: E, payload: AcpClientEventPayloads[E]): void {
    const set = this.#listeners.get(event);
    if (set === undefined) return;
    for (const listener of [...set]) {
      try {
        (listener as unknown as AcpClientListener<E>)(payload);
      } catch (err) {
        this.#log(`listener for '${event}' threw (contained): ${messageOf(err)}`);
      }
    }
  }
}
