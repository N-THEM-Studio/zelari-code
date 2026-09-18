/**
 * K1.6 / F8 — per-claim verification (never wholesale).
 *
 * A report of N claims is not event-backed because ONE evidence event
 * exists. Each claim is matched to evidence by criterion id, produces its
 * own VerificationResult, and the overall verdict is the worst of the set
 * (fail → REPAIR_REQUIRED, else unknown/missing → BLOCKED, else PASS).
 */
import type { CompletionVerdict } from './completionPolicy.js';
import type {
  EvidenceRefTier,
  VerificationResult,
  VerificationStatus,
} from './types.js';

/**
 * A claim anchored to a specific completion criterion (K1.8/F8 per-claim gate).
 * Renamed from `VerificationClaim` to avoid the barrel collision with the
 * pre-existing narrative claim type in `council/verification/honesty.ts`.
 */
export interface CriterionClaim {
  id: string;
  criterionId: string;
  text?: string;
}

export interface ClaimEvidence {
  criterionId?: string;
  seq?: number;
  status?: VerificationStatus;
  tier?: EvidenceRefTier;
  ref?: string;
}

export interface ClaimReportEvaluation {
  claims: Array<{ claimId: string; result: VerificationResult }>;
  overall: CompletionVerdict;
  failedClaimIds: string[];
}

function worstVerdict(statuses: readonly VerificationStatus[]): CompletionVerdict {
  if (statuses.some((s) => s === 'fail')) return 'REPAIR_REQUIRED';
  if (statuses.some((s) => s !== 'pass')) return 'BLOCKED';
  return 'PASS';
}

export function evaluateClaimReport(
  claims: readonly CriterionClaim[],
  evidence: readonly ClaimEvidence[],
  now: number = Date.now(),
): ClaimReportEvaluation {
  const byCriterion = new Map<string, ClaimEvidence>();
  for (const e of evidence) {
    if (e.criterionId) byCriterion.set(e.criterionId, e);
  }
  const evaluated = claims.map((claim) => {
    const ev = byCriterion.get(claim.criterionId);
    const status: VerificationStatus = ev?.status ?? 'unknown';
    const result: VerificationResult = {
      criterionId: claim.criterionId,
      status,
      source: ev ? 'deterministic-engine' : 'verify-agent',
      evidence: ev
        ? [
            {
              tier: ev.tier ?? 'command-output',
              ref: ev.ref ?? claim.criterionId,
              capturedAt: now,
              ...(typeof ev.seq === 'number' && ev.seq > 0 ? { seq: ev.seq } : {}),
            },
          ]
        : [],
      evaluatedAt: now,
      durationMs: 0,
      ...(ev
        ? {}
        : {
            detail: `claim ${claim.id} has no event-backed evidence for criterion ${claim.criterionId}`,
          }),
    };
    return { claimId: claim.id, result };
  });
  const failedClaimIds = evaluated.filter((c) => c.result.status !== 'pass').map((c) => c.claimId);
  return {
    claims: evaluated,
    overall: worstVerdict(evaluated.map((c) => c.result.status)),
    failedClaimIds,
  };
}
