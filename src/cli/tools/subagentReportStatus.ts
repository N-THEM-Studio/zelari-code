/**
 * subagentReportStatus — structured truncation signal for tentacle reports
 * (post-mortem 2026-09-23, G2).
 *
 * Observed failure mode: an `explore` tentacle returned a TRUNCATED report (a
 * fragment of reasoning, no explicit conclusion) and the parent grounded a
 * doomed 45-minute `general` on it. Nothing in the report said the runtime
 * had cut the output — the parent could not tell "the tentacle concluded
 * nothing" from "the conclusion never made it".
 *
 * The `truncated` signal is DERIVED, never guessed: only deterministic
 * runtime facts flip it (see `ReportTruncatedReason`) — the provider output
 * cap cutting a message (`message_end.finishReason === 'length'`), the stream
 * ending mid-message (no `message_end` seal), or a fatal stream error firing
 * while the report message was still open. Never LLM heuristics, never
 * regex/content verdicts on the report text.
 *
 * Two surfaces, one single source of truth:
 *   - `formatReportTruncatedNote()` — appended to the report ITSELF at the
 *     point where the output is compacted/cut (`runSubAgent` finalizes the
 *     report there), so every consumer — parent message, sidecar, memory,
 *     graph executor — reads the truncation declared inside the report;
 *   - `REPORT_TRUNCATED_GUARD_LINE` — the parent-facing guard line the `task`
 *     tool appends when `reportStatus === 'truncated'`, so no new spawn is
 *     grounded on partial information by accident.
 *
 * Pure and total: no I/O, no clock, deterministic.
 */

/** Stable, greppable truncation marker declared inside a cut report. */
export const REPORT_TRUNCATED_MARKER = '[report-truncated]';

/**
 * Parent-facing guard line (G2). Rendered verbatim by the `task` tool when the
 * report is truncated — loud enough to survive skimming.
 */
export const REPORT_TRUNCATED_GUARD_LINE =
  '⚠ report troncato — non usarlo come base per nuovi spawn senza re-investigare';

/**
 * Structured report status exposed on `TentacleResult`. Absent ⇒ 'ok': the
 * field is additive (out-of-tool producers construct the tentacle result
 * shape), while `runTentacle` always sets it explicitly.
 */
export type ReportStatus = 'truncated' | 'ok';

/**
 * Deterministic runtime fact that cut the report:
 *   - `finish-reason-length`   — the provider output cap cut the message
 *     (`message_end.finishReason === 'length'`);
 *   - `stream-cut-mid-message` — the stream ended before `message_end` could
 *     seal the message it was streaming (the report can only be a fragment);
 *   - `fatal-error-mid-message` — a fatal harness error fired while the report
 *     message was still open (the provider stream died mid-text).
 */
export type ReportTruncatedReason =
  | 'finish-reason-length'
  | 'stream-cut-mid-message'
  | 'fatal-error-mid-message';

/**
 * The note appended to a cut report, AT the cut point. Declares the marker,
 * the deterministic reason, and what the parent must do with it.
 */
export function formatReportTruncatedNote(reason: ReportTruncatedReason): string {
  return (
    `${REPORT_TRUNCATED_MARKER} output cut by the runtime before a clean conclusion ` +
    `(${reason}) — PARTIAL report: re-investigate before relying on it`
  );
}

/** Single reason → status mapping (absent/undefined ⇒ 'ok'). */
export function reportStatusOf(reason: ReportTruncatedReason | null | undefined): ReportStatus {
  return reason ? 'truncated' : 'ok';
}
