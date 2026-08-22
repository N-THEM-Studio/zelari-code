/**
 * verification/resourceReserveGate.ts — resource-aware completion interaction
 * (2.6 Track B, doc §11.5, ADR-0023 untouched).
 *
 * The budget NEVER decides PASS. It only decides whether the required
 * evidence is still PRODUCIBLE:
 *
 *   verdict === PASS                      → PASS (deterministic PASS ends
 *                                            even with residual budget)
 *   verdict !== PASS AND evidence still
 *   affordable (repair + verification
 *   reserve not exhausted)                → verdict unchanged (REPAIR_REQUIRED / BLOCKED)
 *   verdict !== PASS AND no budget left
 *   to produce required evidence          → BLOCKED / resource-exhausted
 *
 * false-done is impossible by construction: unknown ≠ pass stays.
 */

import type { ResourceBudget } from '../runtime/resourceBudget.js';
import type { CompletionEvaluation } from './completionPolicy.js';

export interface ResourceReserveGateInput {
  evaluation: CompletionEvaluation;
  budget: ResourceBudget;
}

export interface ResourceReserveGateResult {
  verdict: CompletionEvaluation['verdict'];
  /** Original deterministic verdict (never overwritten — audit trail). */
  deterministicVerdict: CompletionEvaluation['verdict'];
  /** True when the gate downgraded the verdict to BLOCKED. */
  resourceExhausted: boolean;
  /** True when the remaining budget can still run verification/repair calls. */
  evidenceAffordable: boolean;
  summary: string;
}

/**
 * Evidence is affordable while the protected verification reserve has not
 * been consumed by non-verify work AND the repair headroom is not negative.
 */
export function evaluateResourceReserveGate(input: ResourceReserveGateInput): ResourceReserveGateResult {
  const { evaluation, budget } = input;
  if (evaluation.verdict === 'PASS') {
    return {
      verdict: 'PASS',
      deterministicVerdict: 'PASS',
      resourceExhausted: false,
      evidenceAffordable: true,
      summary: evaluation.summary,
    };
  }
  // Remaining outside the reserve is spendable on verify/repair; the reserve
  // itself exists exactly for those calls. Evidence stops being affordable
  // when BOTH the spendable headroom and the reserve are gone.
  const spendable = Math.max(0, budget.toolCalls.remaining - budget.reserve.verification);
  const affordable = spendable + budget.reserve.verification > 0 && budget.toolCalls.remaining > 0;
  if (affordable) {
    return {
      verdict: evaluation.verdict,
      deterministicVerdict: evaluation.verdict,
      resourceExhausted: false,
      evidenceAffordable: true,
      summary: evaluation.summary,
    };
  }
  const summary = `${evaluation.summary} · resource-exhausted: ${budget.toolCalls.used}/${budget.toolCalls.limit} tool calls used, no budget left for required evidence — BLOCKED, not a false done`;
  return {
    verdict: 'BLOCKED',
    deterministicVerdict: evaluation.verdict,
    resourceExhausted: true,
    evidenceAffordable: false,
    summary,
  };
}

