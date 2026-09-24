/**
 * truncatedReportGate — W6.2 runtime soft gate for truncated-report basis
 * (post-mortem 2026-09-23, third leg after G1/G2).
 *
 * Observed failure mode: an `explore` returned a TRUNCATED report and the
 * parent grounded a doomed 45-minute `general` on it. G2 made the truncation
 * LOUD (marker inside the report, guard line to the parent) — but the
 * decision to spawn anyway still rested on lead discipline alone.
 *
 * This gate closes the loop at runtime: when a tentacle result carries
 * `reportStatus === 'truncated'`, the session is flagged; the NEXT `general`
 * spawn in that session gets an explicit basis-warning banner PREPENDED to
 * its prompt (one-shot). Only `general` consumes the flag — explore/verify
 * never do, because re-investigating IS the cure and must stay free.
 *
 * Soft by design: a banner, never a block — a hard reject could deadlock a
 * legitimate flow whose only sin was a cut report two spawns earlier.
 * Kill-switch: ZELARI_KRAKEN_TRUNCATED_REPORT_GATE=0 turns both record and
 * consume into no-ops (default ON: the gate is a harmless banner).
 *
 * State lives in a module-level set keyed by sessionId, encapsulated here:
 * `runTentacle` is a standalone exported function shared by the task tool
 * AND the graph executor, so the flag must span calls — a factory closure
 * would cover only one of the two spawn paths.
 *
 * Pure and total: no I/O, no clock, deterministic.
 */

/** Env kill-switch (default ON — the gate injects a banner, nothing else). */
export const TRUNCATED_REPORT_GATE_ENV = 'ZELARI_KRAKEN_TRUNCATED_REPORT_GATE';

/** Stable, greppable marker carried by the injected banner. */
export const TRUNCATED_REPORT_BANNER_MARKER = '[report-truncated-basis]';

/** The banner injected at the head of the next `general` prompt. */
export const TRUNCATED_REPORT_BANNER =
  `${TRUNCATED_REPORT_BANNER_MARKER} ⚠ the briefing you were spawned from may rest on a ` +
  `TRUNCATED report (the runtime cut it before any conclusion). Re-verify the ` +
  `premises with read/grep BEFORE mutating files — do not trust quoted facts ` +
  `from the parent brief.`;

/** Gate disabled exactly when the env kill-switch is set to '0'. */
export function truncatedReportGateEnabled(): boolean {
  return process.env[TRUNCATED_REPORT_GATE_ENV] !== '0';
}

const flaggedSessions = new Set<string>();

/** Flag a session whose latest tentacle report was truncated. */
export function recordTruncatedReport(sessionId: string): void {
  if (!truncatedReportGateEnabled()) return;
  flaggedSessions.add(sessionId);
}

/**
 * One-shot consume for the next `general` spawn: returns the banner when the
 * session is flagged (and clears the flag), null in every other case.
 * Non-`general` agents never consume — the flag stays armed for the general.
 */
export function consumeTruncatedReportBanner(sessionId: string, agent: string): string | null {
  if (agent !== 'general') return null;
  if (!truncatedReportGateEnabled()) return null;
  if (!flaggedSessions.delete(sessionId)) return null;
  return TRUNCATED_REPORT_BANNER;
}

/** Test-only: wipe the cross-call state. */
export function resetTruncatedReportGateForTests(): void {
  flaggedSessions.clear();
}
