/**
 * Per-tentacle verification verdict — Desktop UI phase F3 (ADR-0023 vocabulary).
 *
 * WHAT THE BACKEND REALLY EMITS (read from the CLI source; nothing invented):
 * `src/cli/tools/taskTool.ts` → `runAutoVerifyAfterGeneral` → `emitVerifyPhase`
 * publishes the general⇒verify obligation on the GENERAL tentacle's own row:
 *
 *   { type: 'agent_status', agentId: <general agent id>, status: 'running',
 *     message: 'verifying…' | 'verify PASS' | 'verify FAIL'
 *            | 'verify unknown' | 'verify failed', ts }
 *
 * (the same caption is dual-written to `.zelari/radio/<sessionId>.jsonl` as
 * `{kind:'progress', agent:'verify', description:`verify: <desc>`, detail, ok}`).
 * The Desktop already keeps `agent_status.message` as `ActivityAgent.phaseMessage`
 * (`activity/reducer.ts`, t94), so this reader uses the SAME field the sidebar
 * already paints as a caption: one signal, one source, no new channel.
 *
 * HONESTY RULES (F3, ADR-0023 "unknown ≠ pass"):
 *   - the caption is a WHITELIST: only the exact tokens below yield a verdict;
 *   - everything else — no caption, still in flight, no parseable verdict, a
 *     degraded verify run — is `unknown` → rendered "—", never PASS;
 *   - a tentacle NEVER inherits the mission verdict: the mission badge reads
 *     `verification_run` (see `readMissionVerdict`) and is labelled as such.
 */
import type { VerificationVerdict } from "./VerificationStatusCard";

/** ADR-0023 vocabulary, plus the explicit "no signal" state. */
export type TentacleVerdict = VerificationVerdict | "unknown";

export interface TentacleVerdictView {
  verdict: TentacleVerdict;
  /** Verbatim backend token the verdict came from; absent when unknown. */
  signal?: string;
}

/**
 * Caption → verdict, taken from `emitVerifyPhase` in `taskTool.ts`.
 * `verify FAIL` is REPAIR_REQUIRED and not BLOCKED on purpose: ADR-0023 maps
 * "`fail` present → REPAIR_REQUIRED" (`BLOCKED` is the mission gate outcome for
 * unknown/missing evidence, and it belongs to the mission badge).
 * `verify unknown` / `verify failed` are deliberately absent: the CLI calls
 * them "a degraded observation is never proof" — no verdict was produced, so
 * the badge stays unknown instead of claiming one.
 */
const CAPTION_VERDICTS: Record<string, TentacleVerdict> = {
  "verify PASS": "PASS",
  "verify FAIL": "REPAIR_REQUIRED",
  // Canonical ADR-0023 tokens: recognised if a backend ever emits them, never
  // inferred from anything else.
  "verify REPAIR_REQUIRED": "REPAIR_REQUIRED",
  "verify BLOCKED": "BLOCKED",
};

/** Shared unknown view (never mutated; `Object.freeze` documents that). */
export const UNKNOWN_TENTACLE_VERDICT: TentacleVerdictView = Object.freeze({
  verdict: "unknown" as const,
});

/** Exact-token read of a verify caption; `unknown` for everything else. */
export function classifyVerifyCaption(caption: string | null | undefined): TentacleVerdict {
  if (typeof caption !== "string") return "unknown";
  return CAPTION_VERDICTS[caption.trim()] ?? "unknown";
}

/**
 * Badge input for ONE tentacle row, read from that row only (`phaseMessage`,
 * i.e. `agent_status.message`). No mission state is consulted here at all —
 * that is what keeps a missing per-tentacle signal an honest "—".
 */
export function readTentacleVerdict(agent?: { phaseMessage?: string }): TentacleVerdictView {
  const caption = agent?.phaseMessage;
  const verdict = classifyVerifyCaption(caption);
  if (verdict === "unknown" || !caption) return UNKNOWN_TENTACLE_VERDICT;
  return { verdict, signal: caption.trim() };
}

/**
 * Mission-level badge input: the verdict already parsed out of the
 * `verification_run` event by `readVerificationRun` — the same source that
 * feeds `VerificationStatusCard`. Passed through unchanged (no re-inference,
 * no downgrade) and rendered with `scope="mission"`; absent = no badge, never
 * a PASS.
 */
export function readMissionVerdict(
  verdict: VerificationVerdict | null | undefined,
): TentacleVerdictView | undefined {
  if (!verdict) return undefined;
  return { verdict, signal: verdict };
}
