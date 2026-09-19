/**
 * acp/invariants — the terminal-frame invariants of the ACP stream.
 *
 * Ported from the OpenHarness provider spec and enforced at RUNTIME here
 * (not by convention):
 *
 *   1. TERMINAL FRAME UNIQUENESS. One turn = one stream = EXACTLY ONE
 *      terminal frame. `TurnStreamTracker` is the guard: `push()` refuses any
 *      frame after the terminal one, `terminate()` refuses a second terminal,
 *      and `assertTerminated()` refuses a stream that closes without one.
 *      On this wire the terminal frame is the `session/prompt` RESPONSE (its
 *      `stopReason`): the ACP subset served here has no reverse requests and
 *      no ask/input round-trip (see protocol.ts non-goals), so
 *      `input_required` is RESERVED: `push()` already treats a
 *      `sessionUpdate: 'input_required'` frame as terminal, and anything
 *      emitted after it (including the response) is a loud violation.
 *   2. NO SILENT TRUNCATION. `clampMessageText()` is the single cap on the
 *      outbound payload path; when it bites the frame MUST carry
 *      `truncated: true` (protocol.ts `agentMessageChunk` does that
 *      automatically). `assertTruncationDisclosed()` is the guard for frames
 *      built by hand: an over-cap payload claiming to be complete fails.
 *   3. STABLE STRING ERROR CODES. The vocabulary is `ACP_ERROR_CODES` in
 *      protocol.ts; `AcpInvariantViolation` carries one, so every violation
 *      that reaches a log line is machine-greppable and never an ad-hoc
 *      message used as a code.
 *
 * Failure policy: the guard THROWS (loud, unit-testable); the transport
 * CATCHES, logs it with its stable code and drops the offending frame (P2 —
 * a bad frame must never kill the JSON-RPC loop). A violation is therefore
 * never silent: it is on stderr, and it never becomes a wire frame.
 *
 * This module imports only TYPES from protocol.ts (erased at runtime), so
 * protocol.ts can use the clamp below without a runtime import cycle.
 */
import type { SessionUpdate, StopReason } from './protocol.js';

// ---------------------------------------------------------------------------
// Invariant 3 — stable STRING error codes (the single source of truth)
// ---------------------------------------------------------------------------

/**
 * The machine vocabulary of the ACP error surface. `protocol.ts` keeps the
 * numeric JSON-RPC envelope the spec requires and re-exports THESE constants,
 * so a code exists once and every emit site uses it: never a number where a
 * code belongs, never an ad-hoc message used as a code (see server.ts, which
 * puts the string in `error.data.code`, next to the numeric `error.code`).
 */
export const ACP_ERROR_CODES = {
  PARSE_ERROR: 'parse_error',
  INVALID_REQUEST: 'invalid_request',
  METHOD_NOT_FOUND: 'method_not_found',
  INVALID_PARAMS: 'invalid_params',
  INTERNAL_ERROR: 'internal_error',
  /** A turn ended without delivering (dispatcher rejected, or exit != 0). */
  TURN_FAILED: 'turn_failed',
  /** A stream invariant was violated (this module's guards). */
  PROTOCOL_ERROR: 'protocol_error',
  /** A payload was clamped, or claims to be complete while over the cap. */
  TRUNCATED_PAYLOAD: 'truncated_payload',
} as const;

export type AcpErrorCode = (typeof ACP_ERROR_CODES)[keyof typeof ACP_ERROR_CODES];

// ---------------------------------------------------------------------------
// Invariant 1 — terminal frame uniqueness
// ---------------------------------------------------------------------------

/**
 * How a turn's stream ended. The ACP `StopReason` values are the response
 * kinds this server can emit; `input_required` is reserved for an ask/input
 * round-trip and is terminal as well (a stream that asks for input is over).
 */
export type TurnTerminalKind = StopReason | 'input_required';

/** `sessionUpdate` values that ARE a terminal frame (reserved, see header). */
export const ACP_TERMINAL_UPDATE_KINDS = ['input_required'] as const;

export type AcpInvariant =
  | 'post_terminal_frame'
  | 'double_terminal'
  | 'missing_terminal'
  | 'truncated_payload';

/**
 * A broken stream invariant. `errorCode` is one of the protocol's stable
 * string codes (invariant 3), so a violation reads the same in a log line and
 * in an error frame.
 */
export class AcpInvariantViolation extends Error {
  constructor(
    readonly invariant: AcpInvariant,
    readonly errorCode: AcpErrorCode,
    detail: string,
  ) {
    super(`${errorCode} ${invariant}: ${detail}`);
    this.name = 'AcpInvariantViolation';
  }
}

/** Terminal kind of one update frame, or null when the frame is not terminal. */
export function terminalUpdateKind(frame: { sessionUpdate?: unknown }): TurnTerminalKind | null {
  const kind = frame?.sessionUpdate;
  if (typeof kind !== 'string') return null;
  return (ACP_TERMINAL_UPDATE_KINDS as readonly string[]).includes(kind)
    ? (kind as TurnTerminalKind)
    : null;
}

/**
 * Per-turn stream state: the one place that decides whether a frame may still
 * be emitted. One instance per turn (never reused across turns).
 */
export class TurnStreamTracker {
  #frames = 0;
  #terminalKind: TurnTerminalKind | null = null;

  constructor(readonly sessionId: string) {}

  /** Non-terminal frames emitted so far (diagnostics/tests). */
  get frames(): number {
    return this.#frames;
  }

  /** True once a terminal frame was recorded (the stream is closed). */
  get terminated(): boolean {
    return this.#terminalKind !== null;
  }

  /** The single terminal kind, or null while the stream is still open. */
  get terminalKind(): TurnTerminalKind | null {
    return this.#terminalKind;
  }

  /**
   * Record one update frame. Throws `post_terminal_frame` when the stream is
   * already closed — a closed stream never reopens and never emits again.
   */
  push(frame: SessionUpdate): TurnTerminalKind | null {
    if (this.#terminalKind !== null) {
      throw new AcpInvariantViolation(
        'post_terminal_frame',
        'protocol_error',
        `session ${this.sessionId}: frame after the terminal '${this.#terminalKind}' frame`,
      );
    }
    this.#frames += 1;
    const terminal = terminalUpdateKind(frame);
    if (terminal !== null) this.#terminalKind = terminal;
    return terminal;
  }

  /** Record the ONE terminal frame. Throws `double_terminal` on a second one. */
  terminate(kind: TurnTerminalKind): void {
    if (this.#terminalKind !== null) {
      throw new AcpInvariantViolation(
        'double_terminal',
        'protocol_error',
        `session ${this.sessionId}: terminal '${kind}' after '${this.#terminalKind}'`,
      );
    }
    this.#terminalKind = kind;
  }

  /**
   * A turn that ends must have terminated exactly once. Returns the kind, or
   * throws `missing_terminal` — call this when the turn is over to make a
   * dropped terminal loud instead of a hung stream.
   */
  assertTerminated(): TurnTerminalKind {
    if (this.#terminalKind === null) {
      throw new AcpInvariantViolation(
        'missing_terminal',
        'protocol_error',
        `session ${this.sessionId}: stream closed after ${this.#frames} frame(s) with no terminal frame`,
      );
    }
    return this.#terminalKind;
  }
}

// ---------------------------------------------------------------------------
// Invariant 2 — no silent truncation
// ---------------------------------------------------------------------------

/**
 * Payload cap for ONE outbound text payload. Deliberately generous: it is a
 * wire-safety bound (a runaway provider/error message must not produce a
 * multi-megabyte frame), not a display policy — so it does not fire on normal
 * traffic and never changes what an existing client sees.
 */
export const ACP_PAYLOAD_MAX_CHARS = 64 * 1024;

/** Clamp to the cap, REPORTING whether it bit (never silently). */
export function clampMessageText(
  text: string,
  cap: number = ACP_PAYLOAD_MAX_CHARS,
): { text: string; truncated: boolean } {
  return text.length <= cap ? { text, truncated: false } : { text: text.slice(0, cap), truncated: true };
}

/**
 * Invariant 2 guard for hand-built frames (a factory call cannot fail this):
 * a text payload over the cap without `truncated: true` throws
 * `truncated_payload`.
 */
export function assertTruncationDisclosed(update: {
  sessionUpdate: unknown;
  content?: { text?: unknown };
  truncated?: unknown;
}): void {
  const text = update?.content?.text;
  if (typeof text !== 'string' || text.length <= ACP_PAYLOAD_MAX_CHARS) return;
  if (update.truncated === true) return;
  throw new AcpInvariantViolation(
    'truncated_payload',
    'truncated_payload',
    `a ${text.length}-char payload exceeds the ${ACP_PAYLOAD_MAX_CHARS}-char cap without a truncated:true flag`,
  );
}

/** One log line for any thrown violation (stable code first, detail after). */
export function violationSummary(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// The three invariants as the SERVER uses them
// ---------------------------------------------------------------------------

/**
 * One turn's outbound stream, with the invariants already applied: callers
 * never see a throw — a violation is logged (fail loud, stable code, on
 * stderr) and the offending frame is DROPPED, so a broken frame can never
 * reach the wire or kill the JSON-RPC loop. `false` means "do not emit".
 */
export interface TurnStream {
  /** Guard + record one update. False = dropped (a violation was logged). */
  push(frame: SessionUpdate): boolean;
  /** Record the terminal frame. False = a second terminal was refused. */
  terminate(kind: TurnTerminalKind): boolean;
  /** The turn is over: assert it terminated exactly once. */
  close(): void;
  readonly tracker: TurnStreamTracker;
}

/** Build the guarded stream for one turn (`log` receives `[zelari-code acp] …`). */
export function createTurnStream(sessionId: string, log: (line: string) => void): TurnStream {
  const tracker = new TurnStreamTracker(sessionId);
  const report = (err: unknown): void => {
    try {
      log(`[zelari-code acp] dropped frame — ${violationSummary(err)}`);
    } catch {
      /* diagnostics must never throw into the transport */
    }
  };
  return {
    tracker,
    push(frame) {
      try {
        assertTruncationDisclosed(frame);
        tracker.push(frame);
        return true;
      } catch (err) {
        report(err);
        return false;
      }
    },
    terminate(kind) {
      try {
        tracker.terminate(kind);
        return true;
      } catch (err) {
        report(err);
        return false;
      }
    },
    close() {
      try {
        tracker.assertTerminated();
      } catch (err) {
        report(err);
      }
    },
  };
}
