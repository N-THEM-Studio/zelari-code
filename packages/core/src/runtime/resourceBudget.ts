/**
 * runtime/resourceBudget.ts — central resource budget projection (2.6 Track B,
 * doc §9). PURE functions: the host owns enforcement; nothing here talks to
 * the model or mutates state. Budget state is reconstructible from the
 * session log (ResourceLedger on the CLI side counts `tool.call` events).
 *
 * Invariants (§9.5 / 2.6.1 plan §9): remaining = max(0, limit - used),
 * reserves >= 0. `used` may exceed the hard limit AFTER the fact (an
 * in-flight essential call landing over budget) — that is the overrun, kept
 * visible, never clamped away.
 */

import type { BudgetPressure, ResourcePolicy, ResourceStage } from './resourcePolicy.js';

export interface ResourceBudget {
  toolCalls: {
    limit: number;
    used: number;
    remaining: number;
    /**
     * 2.6.1 (plan §9): real overrun past the HARD limit — `used` is never
     * clamped. 0 while within budget; 2 when used=42, limit=40.
     */
    overrun: number;
  };
  wallTime: {
    limitMs?: number;
    elapsedMs: number;
    remainingMs?: number;
  };
  tokens?: {
    softLimit?: number;
    used: number;
    remaining?: number;
  };
  reserve: {
    verification: number;
    repair: number;
  };
  stage: ResourceStage;
}

export type ResourceLedgerReason =
  | 'tool-call'
  | 'model-turn'
  | 'verification'
  | 'repair'
  | 'timeout'
  | 'reservation';

/** Host-owned ledger entry (append-only; rebuilt from session events on resume). */
export interface ResourceLedgerEntry {
  seq: number;
  reason: ResourceLedgerReason;
  delta: {
    toolCalls?: number;
    tokens?: number;
    wallMs?: number;
  };
}

/** Compute the budget projection from a policy and cumulative usage. Pure. */
export function computeBudget(
  policy: ResourcePolicy,
  usage: {
    toolCallsUsed: number;
    elapsedMs?: number;
    tokensUsed?: number;
  },
  stage: ResourceStage = 'explore',
): ResourceBudget {
  // 2.6.1 (plan §9): maxToolCalls is a HARD limit — `used` keeps the real
  // count (no clamp), `remaining` floors at 0, and the true overrun is
  // projected so events/denials can reference it.
  const used = Math.max(0, usage.toolCallsUsed);
  const overrun = Math.max(0, used - policy.maxToolCalls);
  return {
    toolCalls: {
      limit: policy.maxToolCalls,
      used,
      remaining: Math.max(0, policy.maxToolCalls - used),
      overrun,
    },
    wallTime: {
      limitMs: policy.wallClockMs,
      elapsedMs: Math.max(0, usage.elapsedMs ?? 0),
      remainingMs: policy.wallClockMs === undefined ? undefined : Math.max(0, policy.wallClockMs - (usage.elapsedMs ?? 0)),
    },
    tokens:
      usage.tokensUsed === undefined && policy.softMaxTokens === undefined
        ? undefined
        : {
            softLimit: policy.softMaxTokens,
            used: usage.tokensUsed ?? 0,
            remaining:
              policy.softMaxTokens === undefined
                ? undefined
                : Math.max(0, policy.softMaxTokens - (usage.tokensUsed ?? 0)),
          },
    reserve: {
      verification: Math.max(0, policy.reserve.verification),
      repair: Math.max(0, policy.reserve.repair),
    },
    stage,
  };
}

/** Reduce the ledger to cumulative usage. Pure; double entries count once by seq. */
export function usageFromLedger(entries: readonly ResourceLedgerEntry[]): {
  toolCallsUsed: number;
  wallMs: number;
  tokensUsed: number;
} {
  const seen = new Set<number>();
  let toolCallsUsed = 0;
  let wallMs = 0;
  let tokensUsed = 0;
  for (const e of entries) {
    if (seen.has(e.seq)) continue; // idempotent replay
    seen.add(e.seq);
    toolCallsUsed += e.delta.toolCalls ?? 0;
    wallMs += e.delta.wallMs ?? 0;
    tokensUsed += e.delta.tokens ?? 0;
  }
  return { toolCallsUsed: Math.max(0, toolCallsUsed), wallMs: Math.max(0, wallMs), tokensUsed: Math.max(0, tokensUsed) };
}

/**
 * Pressure band (§12): usable = remaining - verificationReserve floor.
 * critical < thresholds.critical <= constrained < thresholds.ample <= ample.
 */
export function budgetPressure(budget: ResourceBudget, policy: ResourcePolicy): BudgetPressure {
  const usable = Math.max(0, budget.toolCalls.remaining - budget.reserve.verification);
  const capacity = Math.max(1, budget.toolCalls.limit - budget.reserve.verification);
  const ratio = usable / capacity;
  const t = policy.pressure;
  if (ratio >= t.ample) return 'ample';
  if (ratio >= t.constrained) return 'normal';
  if (ratio >= t.critical) return 'constrained';
  return 'critical';
}

/**
 * Protected verification reserve (§11.3): when true, only the verify/repair
 * tool set may spend — the host enforces, this is the predicate.
 */
export function isVerificationReserveProtected(budget: ResourceBudget): boolean {
  return budget.toolCalls.remaining <= budget.reserve.verification;
}

/** Can the run still afford `calls` outside the protected reserve? */
export function canSpendOutsideReserve(budget: ResourceBudget, calls: number): boolean {
  return budget.toolCalls.remaining - budget.reserve.verification >= calls;
}

/** Map an event stream reason onto the ledger delta (single counting point). */
export function ledgerDeltaFor(reason: ResourceLedgerReason, calls = 1): ResourceLedgerEntry['delta'] {
  switch (reason) {
    case 'tool-call':
      return { toolCalls: calls };
    case 'model-turn':
    case 'verification':
    case 'repair':
      return { toolCalls: calls };
    case 'timeout':
      return {};
    case 'reservation':
      return {};
  }
}
