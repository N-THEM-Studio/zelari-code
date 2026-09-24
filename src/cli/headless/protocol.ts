/**
 * Headless control-plane protocol v2 (Frontier upgrade PHASE 2, §35).
 *
 * Event factories for the bidirectional headless channel:
 *   stdin  ← ControlEvent NDJSON (see controlReader.ts)
 *   stdout → BrainEvent NDJSON (acks below + protocol_info handshake)
 *
 * Desktop must gate Steer UI on `protocol_info.version >= 2` and on
 * `control_accepted` (never assume stdin writes took effect, §24).
 */

/** Bump when the stdout event set or stdin contract changes. */
export const HEADLESS_PROTOCOL_VERSION = 2;

/**
 * STABLE STRING error codes for the headless control plane (invariant 3, same
 * rule as acp/protocol.ts): a code is a stable identifier a host can branch
 * on, never a number and never a human message. Rejection acks carry theirs in
 * `code`; `reason` stays the human-readable detail.
 */
export const HEADLESS_ERROR_CODES = {
  /** The control line/params were unusable (malformed JSON, bad shape). */
  CONTROL_REJECTED: 'control_rejected',
  /** Carried by the ControlEvent union but not mapped onto runtime semantics. */
  CONTROL_UNSUPPORTED: 'control_unsupported',
  /** The run was already finished — the control arrived too late. */
  RUN_ALREADY_FINISHED: 'run_already_finished',
  /** A turn ended without delivering. */
  TURN_FAILED: 'turn_failed',
  /** A stream invariant was violated (see acp/invariants.ts). */
  PROTOCOL_ERROR: 'protocol_error',
  /** A payload was clamped to the cap below. */
  TRUNCATED_PAYLOAD: 'truncated_payload',
} as const;

export type HeadlessErrorCode = (typeof HEADLESS_ERROR_CODES)[keyof typeof HEADLESS_ERROR_CODES];

/**
 * Cap for ONE outbound `reason` string. A control rejection can carry a
 * provider/fs error message of arbitrary size; the cap keeps the NDJSON frame
 * bounded and — invariant 2 — a clamped reason is ALWAYS disclosed with
 * `truncated: true` (see `controlRejectedEvent`). Generous on purpose: it
 * never fires on normal traffic.
 */
export const HEADLESS_REASON_MAX_CHARS = 2000;

/** Capabilities advertised by this CLI build (§35). */
export const HEADLESS_PROTOCOL_CAPABILITIES = [
  'stdin-control',
  'steer',
  'follow_up',
  'cancel',
  // Every NDJSON line a served turn writes carries `harnessSessionId` (the
  // id `session.create` returned), so a multi-chat host routes each line to
  // its chat deterministically — no spine-bind heuristic, no pre-spine
  // serialization. Absent on plain `--headless` (no harness session).
  'session-routing',
] as const;

/** Routing key stamped on every line of a served turn (`session-routing`). */
export const HARNESS_SESSION_FIELD = 'harnessSessionId';

export function protocolInfoEvent(): {
  type: 'protocol_info';
  version: number;
  capabilities: readonly string[];
  ts: number;
} {
  return {
    type: 'protocol_info',
    version: HEADLESS_PROTOCOL_VERSION,
    capabilities: HEADLESS_PROTOCOL_CAPABILITIES,
    ts: Date.now(),
  };
}

export interface ControlAckEvent {
  type: 'control_accepted' | 'control_applied' | 'control_rejected';
  controlId: string;
  controlType?: string;
  boundary?: string;
  reason?: string;
  /** Stable string error code (invariant 3) — present on rejections. */
  code?: HeadlessErrorCode;
  /** Invariant 2: true iff `reason` was clamped to HEADLESS_REASON_MAX_CHARS. */
  truncated?: true;
  ts: number;
}

export function controlAcceptedEvent(
  controlId: string,
  controlType: string,
): ControlAckEvent {
  return {
    type: 'control_accepted',
    controlId,
    controlType,
    ts: Date.now(),
  };
}

export function controlAppliedEvent(
  controlId: string,
  controlType: string,
  boundary: string,
): ControlAckEvent {
  return {
    type: 'control_applied',
    controlId,
    controlType,
    boundary,
    ts: Date.now(),
  };
}

/**
 * A rejected control. `code` is a stable string code (invariant 3) chosen by
 * the caller — default `control_rejected` — and `reason` is the human detail.
 * The reason is clamped to HEADLESS_REASON_MAX_CHARS and the clamp is ALWAYS
 * disclosed with `truncated: true` (invariant 2: no silent truncation).
 */
export function controlRejectedEvent(
  controlId: string,
  reason: string,
  code: HeadlessErrorCode = HEADLESS_ERROR_CODES.CONTROL_REJECTED,
): ControlAckEvent {
  const clamped = reason.length > HEADLESS_REASON_MAX_CHARS;
  return {
    type: 'control_rejected',
    controlId,
    reason: clamped ? reason.slice(0, HEADLESS_REASON_MAX_CHARS) : reason,
    code,
    ...(clamped ? { truncated: true as const } : {}),
    ts: Date.now(),
  };
}
