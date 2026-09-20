/**
 * acpTransport — the seam between the protocol client and the process that
 * runs `zelari-code acp`.
 *
 * The client (acpClient.ts) only ever sees this interface: frames out,
 * chunks in, termination events. Production supplies childTransport.ts (a
 * real child process); the vitest suite supplies an in-memory duplex. That is
 * what makes the protocol layer testable with NO VS Code host, no child
 * process and no network.
 *
 * ZERO `vscode` imports here on purpose (dependency direction: extension.ts →
 * acpClient.ts → acpTransport.ts; never the other way).
 */

/** Handle returned by a subscription (structurally `vscode.Disposable`). */
export interface AcpDisposable {
  dispose(): void;
}

export interface AcpTransport {
  /** Write one already-framed chunk to the agent's stdin. */
  write(chunk: string): void;
  /** Raw stdout chunks; framing happens in the client. */
  onData(listener: (chunk: string) => void): void;
  /** Agent stdout closed: no further data will arrive (EOF salvage point). */
  onEnd(listener: () => void): void;
  /** The agent process exited (a real process fires this last). */
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  /** Spawn/pipe failure — a dead stdin write (EPIPE) counts as one. */
  onError(listener: (error: Error) => void): void;
  /** Agent stderr, already split into lines (diagnostics, never protocol). */
  onStderr(listener: (line: string) => void): void;
  /** Close the agent's stdin: EOF is the agent's clean-shutdown signal. */
  endInput(): void;
  /** Hard stop (fallback when EOF does not end the agent in time). */
  kill(): void;
}

/**
 * Why an ACP session ended. The FIRST terminal event wins: a client emits
 * exactly one `closed`, even though a real child fires `end` then `exit`.
 */
export type AcpCloseReason = 'shutdown' | 'exit' | 'end' | 'error';

export interface AcpCloseInfo {
  reason: AcpCloseReason;
  code: number | null;
  signal: string | null;
  message?: string;
}

export interface AcpExitInfo {
  code: number | null;
  signal: string | null;
}

/** A notification the agent sent that is not `session/update`. */
export interface AcpNotification {
  method: string;
  params: unknown;
}

/**
 * Stable string error codes (never a message used as a code), mirroring the
 * vocabulary the server keeps in src/cli/acp/invariants.ts: a failure reads
 * the same in a test, in a log line and in the OutputChannel.
 */
export const ACP_CLIENT_ERROR_CODES = {
  /** A request was attempted (or was in flight) after the session closed. */
  CLIENT_CLOSED: 'client_closed',
  /** The agent answered with a JSON-RPC error (see `jsonRpcCode` + `errorCode`). */
  RESPONSE_ERROR: 'response_error',
  /** A response did not satisfy the subset documented in protocol.ts. */
  PROTOCOL_ERROR: 'protocol_error',
} as const;

export type AcpClientErrorCode =
  (typeof ACP_CLIENT_ERROR_CODES)[keyof typeof ACP_CLIENT_ERROR_CODES];

/** The session is closed: a request cannot start, or a pending one is dropped. */
export class AcpClientClosedError extends Error {
  readonly code = ACP_CLIENT_ERROR_CODES.CLIENT_CLOSED;

  constructor(detail = 'the ACP session is closed') {
    super(detail);
    this.name = 'AcpClientClosedError';
  }
}

/**
 * The agent rejected a request. BOTH codes are preserved: the numeric
 * JSON-RPC one the spec requires and the stable string code the server puts
 * in `error.data.code` — a caller branches on the string, never on a message.
 */
export class AcpResponseError extends Error {
  readonly code = ACP_CLIENT_ERROR_CODES.RESPONSE_ERROR;

  constructor(
    readonly jsonRpcCode: number,
    message: string,
    readonly errorCode: string,
  ) {
    super(message);
    this.name = 'AcpResponseError';
  }
}

/** A response that violates the served subset (e.g. no `sessionId`). */
export class AcpProtocolError extends Error {
  readonly code = ACP_CLIENT_ERROR_CODES.PROTOCOL_ERROR;

  constructor(detail: string) {
    super(detail);
    this.name = 'AcpProtocolError';
  }
}
