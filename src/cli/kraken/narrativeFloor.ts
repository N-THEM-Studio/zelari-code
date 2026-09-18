/**
 * K1.5 — instrumental floor for auto-verify results.
 *
 * A tentacle `pass` (or a `VERDICT: PASS` trailer) is advisory. PASS
 * requires ≥1 admissible instrumental artifact (tool-output, command-output,
 * fs-observation). Narrative-only → `unknown`. Same floor as K1.3 in
 * taskTool.ts; applied AFTER evidence anchoring so a matched tool trace
 * can still certify the criterion.
 */
import { EVENT_BACKED_EVIDENCE_TIERS, type VerificationResult } from '@zelari/core/verification';

const NARRATIVE_FLOOR_DETAIL =
  'narrative-only PASS does not satisfy the auto-verify floor';

export function applyInstrumentalFloor(results: VerificationResult[]): void {
  for (const r of results) {
    if (r.status !== 'pass') continue;
    const instrumental = r.evidence.some((e) => EVENT_BACKED_EVIDENCE_TIERS.includes(e.tier));
    if (instrumental) continue;
    r.status = 'unknown';
    r.detail = r.detail ? `${r.detail}; ${NARRATIVE_FLOOR_DETAIL}` : NARRATIVE_FLOOR_DETAIL;
  }
}
