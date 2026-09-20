/**
 * WS7 slice 4 (t139) — the ONE best-effort writer for the decision-point kinds
 * whose vocabulary landed in slice 2 (`packages/core/src/session/decisionEvents.ts`).
 *
 * Slice 2 declared the vocabulary, the payload contracts and the replay
 * projection; this module is the runtime half: every seam that RESOLVES a
 * decision (the permission gate, the OS-jail preflight, the ask_user tool, the
 * auto-verify chain) calls in here with the SAME `SessionEventInput` sink the
 * file.* telemetry uses (`ToolContext.emitSessionEvent`, or the bound
 * verify-debt spine emitter) — no second sink is invented.
 *
 * Contract (mirrors `emitPermissionDenied`, WS1):
 *   - the payload is validated against its kind's contract
 *     (`decisionPayloadError`) BEFORE the sink is touched: a malformed
 *     decision line would poison every later replay, so it is dropped, never
 *     written;
 *   - a missing sink, a throwing sink or a validation failure returns
 *     `{recorded: false}` and NEVER propagates: recording a decision must not
 *     be able to change the decision itself;
 *   - the seq (`{seq}` from the writer, when the sink echoes it) is returned
 *     so a caller may anchor follow-up telemetry on the event it just wrote.
 *
 * @since v2.56.0 (WS7 slice 4 / t139)
 */
import type { SessionEventInput, SessionActor } from '@zelari/core/session';
import { decisionPayloadError, type DecisionEventKind } from '@zelari/core/session';
import type { JailMode } from './osJail.js';

/** Session-spine sink shape (ToolContext.emitSessionEvent / SpineEmit). */
export type DecisionEventSink = (input: SessionEventInput) => Promise<unknown>;

export interface DecisionEmitResult {
  recorded: boolean;
  /** Writer-assigned seq, when the sink echoed one. */
  seq?: number;
  /** One-line contract violation, when the payload was rejected (not written). */
  error?: string;
}

/** Actor used by the decision seams: the harness itself, never the model. */
export const DECISION_ACTOR: SessionActor = { type: 'system' };

function seqFrom(result: unknown): number | undefined {
  const raw =
    result !== null && typeof result === 'object' && 'seq' in result
      ? (result as { seq: unknown }).seq
      : undefined;
  const seq = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(seq) && seq > 0 ? seq : undefined;
}

/**
 * Validate → append, best-effort. Returns what actually happened; never throws.
 */
export async function emitDecisionEvent(
  sink: DecisionEventSink | undefined,
  kind: DecisionEventKind,
  data: Record<string, unknown>,
  actor: SessionActor = DECISION_ACTOR,
): Promise<DecisionEmitResult> {
  const contractError = decisionPayloadError(kind, data);
  if (contractError !== null) return { recorded: false, error: contractError };
  if (!sink) return { recorded: false };
  try {
    const result = await sink({ kind, actor, data });
    const seq = seqFrom(result);
    return seq !== undefined ? { recorded: true, seq } : { recorded: true };
  } catch {
    return { recorded: false };
  }
}

/**
 * `jail.blocked` — the OS jail refused a spawn (`ZELARI_OS_JAIL=required` with
 * no honest backend ⇒ typed `[jail]` deny, never a silent unjailed run). The
 * payload is the deny's OWN facts: which backend failed, under which mode, why,
 * and which exec tool owned the spawn.
 */
export async function emitJailBlocked(
  sink: DecisionEventSink | undefined,
  payload: { reason: string; backend: string; mode: JailMode; tool?: string },
): Promise<DecisionEmitResult> {
  return emitDecisionEvent(sink, 'jail.blocked', {
    ...(payload.tool !== undefined ? { tool: payload.tool } : {}),
    backend: payload.backend,
    mode: payload.mode,
    reason: payload.reason,
  });
}
