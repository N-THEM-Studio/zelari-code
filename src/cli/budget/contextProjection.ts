/**
 * contextProjection — budget-pipeline → `context.projection` note (T4 / ADR-0032).
 *
 * The CLI budget pipeline is the canonical compiler. Occupancy / token /
 * policy already live on `BudgetPolicy`; this module projects them onto the
 * spine as identifiers and counters ONLY (no message contents). Optional
 * fields — old 2-field notes still replay. SCHEMA_VERSION stays 1.
 */
import type { BudgetPolicy } from './tokenBudget.js';
import { capabilitiesFor } from '../provider/capabilities.js';

export type BudgetProjectionPolicy = 'ok' | 'warn' | 'compact' | 'hard';

export interface CompactionThresholds {
  warnAt: number;
  compactAt: number;
  hardAt: number;
}

/** Payload written on the `context.projection` note from the budget path. */
export interface BudgetProjectionRecord {
  occupancy: number;
  estimatedHistoryTokens: number;
  contextLimit: number;
  contextPressureTokens?: number;
  policy: BudgetProjectionPolicy;
}

const DEFAULT_THRESHOLDS: CompactionThresholds = {
  warnAt: 0.7,
  compactAt: 0.85,
  hardAt: 0.95,
};

export function policyFromOccupancy(
  occupancy: number,
  thresholds: CompactionThresholds = DEFAULT_THRESHOLDS,
): BudgetProjectionPolicy {
  if (occupancy >= thresholds.hardAt) return 'hard';
  if (occupancy >= thresholds.compactAt) return 'compact';
  if (occupancy >= thresholds.warnAt) return 'warn';
  return 'ok';
}

export function recordFromBudget(
  budget: Pick<
    BudgetPolicy,
    'occupancy' | 'estimatedHistoryTokens' | 'contextLimit' | 'contextPressureTokens'
  >,
  thresholds: CompactionThresholds = DEFAULT_THRESHOLDS,
): BudgetProjectionRecord {
  return {
    occupancy: budget.occupancy,
    estimatedHistoryTokens: budget.estimatedHistoryTokens,
    contextLimit: budget.contextLimit,
    ...(budget.contextPressureTokens !== undefined
      ? { contextPressureTokens: budget.contextPressureTokens }
      : {}),
    policy: policyFromOccupancy(budget.occupancy, thresholds),
  };
}

export function thresholdsFor(model?: string, provider?: string): CompactionThresholds {
  return capabilitiesFor(model, provider).compaction;
}

/**
 * Write one budget projection note. Never throws — telemetry must not
 * break the run. Does not include contextChars/returnedCount (those stay
 * on the memory-path note); SupportLens is an array of both.
 */
export function noteBudgetProjection(
  handle: { note(text: string, data?: Record<string, unknown>): void },
  record: BudgetProjectionRecord,
): void {
  try {
    handle.note('context.projection', {
      subject: 'context.projection',
      occupancy: record.occupancy,
      estimatedHistoryTokens: record.estimatedHistoryTokens,
      contextLimit: record.contextLimit,
      ...(record.contextPressureTokens !== undefined
        ? { contextPressureTokens: record.contextPressureTokens }
        : {}),
      policy: record.policy,
    });
  } catch {
    // Degraded spine must NEVER break the run over telemetry.
  }
}
