/**
 * mission/budgetContinuation.ts — budget-aware repair/pivot/hold (2.6 Track B,
 * doc §13). Companion to continuationPolicy.ts (which stays advisory and
 * user-steer-sovereign); this module adds the RESOURCE dimension:
 *
 *   VerificationEngine → deterministic truth (unchanged authority)
 *   ResourcePolicy     → next-action feasibility (this module)
 *
 * Decisions: complete | repair | pivot | hold. Never "continue just because
 * budget remains" — spend must raise the probability of a verified solve.
 */

import type { ResourceBudget } from '../runtime/resourceBudget.js';
import type { BudgetPressure } from '../runtime/resourcePolicy.js';

export type ContinuationDecision = 'complete' | 'repair' | 'pivot' | 'hold';

export interface RepairAttempt {
  /** Fingerprint of the failure the repair targeted. */
  gapKey: string;
  outcome: 'improved' | 'unchanged' | 'worse';
}

export interface BudgetContinuationInput {
  /** Deterministic verification verdict (authority — never overridden here). */
  verdict: 'PASS' | 'REPAIR_REQUIRED' | 'BLOCKED';
  budget: ResourceBudget;
  pressure: BudgetPressure;
  /** Stable fingerprint of the current gap (undefined when none). */
  latestGapKey?: string;
  repairHistory: readonly RepairAttempt[];
  /** User steer stays sovereign (checked by callers before this policy). */
}

export interface BudgetContinuationAdvice {
  decision: ContinuationDecision;
  rationale: string;
  /** Locked: the budget never converts a non-PASS into completion. */
  passByBudget: false;
}

const MAX_SAME_GAP_REPAIRS = 3;

export function evaluateBudgetContinuation(input: BudgetContinuationInput): BudgetContinuationAdvice {
  const base = { passByBudget: false as const };
  const { verdict, budget, pressure, latestGapKey, repairHistory } = input;

  // 1. Deterministic PASS always completes — even with residual budget left.
  if (verdict === 'PASS') {
    return { ...base, decision: 'complete', rationale: 'deterministic PASS — complete without spending residual budget' };
  }

  // 2. Structural/critical: no room to produce evidence honestly.
  if (pressure === 'critical' && budget.toolCalls.remaining <= budget.reserve.verification) {
    return {
      ...base,
      decision: 'hold',
      rationale: `critical pressure (${budget.toolCalls.remaining}/${budget.toolCalls.limit} left, reserve ${budget.reserve.verification} protected) — hold for operator instead of a doomed repair`,
    };
  }

  // 3. Repeated identical gap → the current approach is not working; pivot.
  const sameGapRepairs = latestGapKey
    ? repairHistory.filter((r) => r.gapKey === latestGapKey && r.outcome === 'unchanged').length
    : 0;
  if (sameGapRepairs >= MAX_SAME_GAP_REPAIRS) {
    const canPivot = budget.toolCalls.remaining - budget.reserve.verification >= 3;
    return canPivot
      ? {
          ...base,
          decision: 'pivot',
          rationale: `gap "${latestGapKey}" unchanged after ${sameGapRepairs} repairs — pivot approach while budget remains`,
        }
      : {
          ...base,
          decision: 'hold',
          rationale: `gap "${latestGapKey}" unchanged after ${sameGapRepairs} repairs and no headroom to pivot — hold`,
        };
  }

  // 4. GAP + spendable headroom → targeted repair.
  const repairHeadroom = budget.toolCalls.remaining - budget.reserve.verification;
  if (repairHeadroom > 0) {
    return {
      ...base,
      decision: 'repair',
      rationale: `${repairHeadroom} spendable tool calls (pressure ${pressure}) — targeted repair on the known gap`,
    };
  }

  // 5. Only the reserve remains: verification/finalization still admissible,
  //    further repair is not.
  if (budget.toolCalls.remaining > 0) {
    return {
      ...base,
      decision: 'hold',
      rationale: 'only the protected verification reserve remains — verify/finalize or hold, no further repair',
    };
  }
  return { ...base, decision: 'hold', rationale: 'budget exhausted — hold (BLOCKED, never a false done)' };
}
