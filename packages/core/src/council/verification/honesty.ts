import type { EvidenceRef, EvidenceRefTier } from '../../verification/types.js';
import type { VerificationCheckResult } from './types.js';

const UNVERIFIED_CLAIM_RE =
  /\b(verificat[oi]|confermat[oi]|nessuna\s+regressione|pronto\s+al\s+commit|✓|Lighthouse\s*≥|axe\s+(clean|pulito)|CLS\s*[<≤])\b/i;

const EVIDENCE_MARKERS_RE =
  /\b(path:|L\d+|evidence:|verification-report|\.zelari\/|bash:|grep_|wc\s+-c)\b/i;

/**
 * Tiers that capture raw observations. Only these can CLEAR a verification
 * claim; advisory tiers (verifier-llm, human) never do — they can propose,
 * not promote (P1 proposer/measurer separation, ADR-0036).
 */
const TRACEABLE_TIERS: readonly EvidenceRefTier[] = [
  'tool-output',
  'command-output',
  'fs-observation',
];

/** One verification claim extracted from synthesis text, with its backing. */
export interface VerificationClaim {
  /** The sentence that asserts verification. */
  text: string;
  /** True when a traceable EvidenceRef backs the claim. */
  matched: boolean;
  /** Evidence tier that cleared the claim, or 'claimed' when unbacked. */
  tier: EvidenceRefTier | 'claimed';
  /** The matching EvidenceRef.ref when matched. */
  ref?: string;
}

/**
 * Split synthesis text into the sentences that assert verification
 * (deterministic: same regex the legacy lint used, applied per sentence).
 */
export function extractVerificationClaims(text: string | undefined): string[] {
  if (!text?.trim()) return [];
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && UNVERIFIED_CLAIM_RE.test(s));
}

/**
 * Tokens that can tie a claim to evidence: path-like strings (contain '/' or
 * '.') and bare numbers/line refs. Prose words are deliberately ignored so a
 * claim is never "cleared" by a coincidental word overlap. Sentence-final
 * punctuation (.,;:!?) and wrapping brackets/quotes are stripped first — a
 * trailing period must not break `ref.includes(token)`.
 */
function claimTokens(sentence: string): string[] {
  const raw = sentence.match(/[A-Za-z0-9_.\/-]{4,}/g) ?? [];
  return raw
    .map((t) =>
      t
        .replace(/^[([{'"`]+/, '')
        .replace(/[\])}'"`]+$/, '')
        .replace(/[.,;:!?]+$/, ''),
    )
    .filter((t) => t.length >= 4 && (/[\/.]/.test(t) || /^L?\d+$/.test(t)));
}

/**
 * Match each claim sentence against the evidence set. A claim is cleared only
 * when a TRACEABLE-tier EvidenceRef shares a concrete token (file path, id,
 * number) with the claim. Advisory tiers leave the claim at 'claimed'.
 */
export function matchClaimsToEvidence(
  claims: readonly string[],
  evidence: readonly EvidenceRef[],
): VerificationClaim[] {
  return claims.map((text) => {
    const tokens = claimTokens(text);
    if (tokens.length > 0) {
      for (const ref of evidence) {
        if (!TRACEABLE_TIERS.includes(ref.tier)) continue;
        if (tokens.some((t) => ref.ref.includes(t))) {
          return { text, matched: true, tier: ref.tier, ref: ref.ref };
        }
      }
    }
    return { text, matched: false, tier: 'claimed' };
  });
}

/**
 * Flag synthesis text that asserts verification without citing evidence.
 *
 * Two modes (back-compat contract):
 *  - `evidence` omitted → legacy whole-text heuristic (unchanged behaviour;
 *    existing callers/tests see the exact same results);
 *  - `evidence` provided → claim-level matching against EvidenceRef (ADR-0023):
 *    only claims with NO traceable backing are flagged, and a claim cleared by
 *    advisory tiers (verifier-llm/human) stays flagged — tier 'claimed' never
 *    becomes 'pass' by linting (P1: unknown ≠ pass).
 */
export function lintSynthesisHonesty(
  synthesisText: string | undefined,
  evidence?: readonly EvidenceRef[],
): VerificationCheckResult[] {
  if (!synthesisText?.trim()) {
    return [];
  }
  const claims = extractVerificationClaims(synthesisText);
  if (claims.length === 0) {
    return [];
  }
  if (evidence) {
    const unmatched = matchClaimsToEvidence(claims, evidence).filter((c) => !c.matched);
    if (unmatched.length === 0) {
      return [];
    }
    return [{
      id: 'synthesis.honesty',
      severity: 'error',
      ok: false,
      tier: 'grep',
      message: `Synthesis asserts verification in ${unmatched.length} claim(s) with no traceable evidence — tier stays 'claimed'`,
      evidence: unmatched.map((c) => c.text.slice(0, 120)).join(' | ').slice(0, 200),
    }];
  }
  const hasEvidence = EVIDENCE_MARKERS_RE.test(synthesisText) ||
    /##\s+Verification\s+status/i.test(synthesisText);
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
