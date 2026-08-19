/**
 * mission/continuationPolicy.ts — advisory mission continuation (2.0 Phase 4,
 * doc §6 "mission progress / advisory early-stop").
 *
 * Integrates mission evidence (deterministic progress from the spine) with an
 * optional verifier trend into a CONTINUATION RECOMMENDATION. The policy is
 * advisory-only by construction:
 *
 *   - it never rewrites the mission goal (`goalRewrite: false`, literal);
 *   - a score alone never marks the mission done (`doneByScore: false`) —
 *     final authority stays with the driver + CompletionPolicy;
 *   - it NEVER recommends stopping while required criteria are incomplete
 *     (no score-based early-stop);
 *   - an explicit user steer always wins over any trend.
 */

import type { MissionProgress } from './missionState.js';

export type MissionContinuationRecommendation = 'continue' | 'wind-down' | 'hold-for-user';

/** Optional verifier trend (from VerifierService.progressScore + review). */
export interface MissionVerifierTrend {
  tier: 'deterministic' | 'blended';
  value: number | null;
  /** Verifier review verdict when one ran (advisory, never authority). */
  verdict?: 'confirmed' | 'rejected' | 'unknown';
}

export interface MissionContinuationInput {
  /** Deterministic progress (last verification / slice evidence). */
  progress: MissionProgress;
  /** Optional verifier trend — recorded as context, never authority. */
  verifier?: MissionVerifierTrend;
  /** Iteration budget state (driver stop rules stay deterministic). */
  budget?: { iterationsUsed: number; iterationsMax: number };
  /** Explicit user steer — always sovereign over trend-derived advice. */
  userSteer?: 'continue' | 'stop';
}

export interface MissionContinuationAdvice {
  recommendation: MissionContinuationRecommendation;
  rationale: string;
  /** Why wind-down is not admissible yet (required criteria gaps). */
  blockers: string[];
  /** Verifier trend as recorded context (absent when no verifier ran). */
  trend?: { tier: string; value: number | null };
  /** Advisory contract (locked): the policy NEVER rewrites the goal. */
  goalRewrite: false;
  /** Advisory contract (locked): a score alone NEVER marks the mission done. */
  doneByScore: false;
}

/** Conservative bands for the blended (experimental) trend. */
const CONFIRMED_BLEND = 0.8;
const REJECTED_BLEND = 0.35;

function requiredBlockers(progress: MissionProgress): string[] {
  const blockers: string[] = [];
  if (progress.ratio === null) {
    blockers.push('no verification criteria recorded yet');
    return blockers;
  }
  const missing = progress.criteriaTotal - progress.criteriaPassed;
  if (missing > 0) {
    blockers.push(`${missing}/${progress.criteriaTotal} required criteria not passing`);
  }
  if (progress.criteriaPassed === progress.criteriaTotal && !progress.evidenceComplete) {
    blockers.push('all criteria pass but evidence is incomplete (not event-backed)');
  }
  return blockers;
}

/**
 * Evaluate the advisory continuation recommendation. Pure and deterministic.
 *
 * Precedence: user steer → budget exhausted → required-incomplete (continue)
 * → verifier-advisory bands on a fully-evidenced PASS.
 */
export function evaluateMissionContinuation(input: MissionContinuationInput): MissionContinuationAdvice {
  const { progress, verifier, budget, userSteer } = input;
  const base = { goalRewrite: false as const, doneByScore: false as const };
  const trend = verifier ? { tier: verifier.tier, value: verifier.value } : undefined;
  const blockers = requiredBlockers(progress);

  // 1. User steer is sovereign.
  if (userSteer === 'stop') {
    return {
      ...base,
      recommendation: 'wind-down',
      rationale: 'user steer: explicit stop — winding down without claiming done',
      blockers,
      trend,
    };
  }
  if (userSteer === 'continue') {
    return {
      ...base,
      recommendation: 'continue',
      rationale: 'user steer: explicit continue — overrides any trend-derived advice',
      blockers,
      trend,
    };
  }

  // 2. Budget exhausted: the driver's stop rule fires regardless; surface it
  //    for the operator (raise budget / stop). Never claims done.
  if (budget && budget.iterationsUsed >= budget.iterationsMax) {
    return {
      ...base,
      recommendation: 'hold-for-user',
      rationale: `iteration budget exhausted (${budget.iterationsUsed}/${budget.iterationsMax}) — operator decides: raise budget or hand off`,
      blockers,
      trend,
    };
  }

  // 3. Required criteria incomplete → ALWAYS continue. No score-based
  //    early-stop, whatever the (experimental) trend says.
  if (blockers.length > 0) {
    const trendNote = verifier
      ? ` · verifier trend recorded as context only (tier ${verifier.tier}${verifier.value === null ? '' : `, ${verifier.value.toFixed(2)}`}) — trend is never authority`
      : '';
    return {
      ...base,
      recommendation: 'continue',
      rationale: `required criteria incomplete → no early-stop${trendNote}`,
      blockers,
      trend,
    };
  }

  // 4. Fully-evidenced deterministic PASS. The verifier may only add an
  //    advisory risk signal — it cannot rewrite the deterministic verdict.
  const blended = verifier?.tier === 'blended' ? verifier.value : null;
  const rejected =
    verifier?.verdict === 'rejected' || (blended !== null && blended <= REJECTED_BLEND);
  if (rejected) {
    return {
      ...base,
      recommendation: 'hold-for-user',
      rationale:
        'deterministic evidence is complete and PASSing, but the verifier flags risk — attention requested; the deterministic verdict stands untouched',
      blockers: [],
      trend,
    };
  }
  const confirmed =
    verifier?.verdict === 'confirmed' || (blended !== null && blended >= CONFIRMED_BLEND);
  return {
    ...base,
    recommendation: 'wind-down',
    rationale: confirmed
      ? 'required criteria pass with evidence and the verifier confirms — candidate done (final say: driver + CompletionPolicy)'
      : 'required criteria pass with evidence — candidate done on deterministic evidence (final say: driver + CompletionPolicy)',
    blockers: [],
    trend,
  };
}
