import type { VerificationCheckResult } from './types.js';

const UNVERIFIED_CLAIM_RE =
  /\b(verificat[oi]|confermat[oi]|nessuna\s+regressione|pronto\s+al\s+commit|✓|Lighthouse\s*≥|axe\s+(clean|pulito)|CLS\s*[<≤])\b/i;

const EVIDENCE_MARKERS_RE =
  /\b(path:|L\d+|evidence:|verification-report|\.zelari\/|bash:|grep_|wc\s+-c)\b/i;

/**
 * Flag synthesis text that asserts verification without citing evidence.
 */
export function lintSynthesisHonesty(synthesisText: string | undefined): VerificationCheckResult[] {
  if (!synthesisText?.trim()) {
    return [];
  }
  const hasClaim = UNVERIFIED_CLAIM_RE.test(synthesisText);
  const hasEvidence = EVIDENCE_MARKERS_RE.test(synthesisText) ||
    /##\s+Verification\s+status/i.test(synthesisText);
  if (!hasClaim) {
    return [];
  }
  if (hasEvidence) {
    return [];
  }
  return [{
    id: 'synthesis.honesty',
    severity: 'error',
    ok: false,
    tier: 'grep',
    message: 'Synthesis asserts verification (✓/verificato/regressione/Lighthouse) without Evidence table or report reference',
    evidence: synthesisText.slice(0, 200),
  }];
}
