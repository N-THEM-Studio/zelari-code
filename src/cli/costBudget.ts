/**
 * src/cli/costBudget.ts — session cost budget with HOLD (W4.1, ADR-0013 pattern).
 *
 * The mission loop already caps cumulative cost/tokens (resolveMaxCost /
 * resolveMaxTokens in zelariMission.ts). This module extends the same logic
 * to interactive TUI sessions: when the configured budget is reached the
 * session enters HOLD — no new provider turn starts, but all state (history,
 * transcript, todos) is preserved. P3: the budget is advisory to the loop,
 * never destructive.
 *
 * Pure + process-singleton (one TUI process == one session); no I/O here so
 * the arithmetic is unit-testable in isolation.
 */

export interface SessionBudget {
  maxUsd?: number;
  maxTokens?: number;
}

export type BudgetState = 'off' | 'ok' | 'warn' | 'hold';

export interface BudgetStatus {
  state: BudgetState;
  usedUsd: number;
  usedTokens: number;
  /** Share of the USD budget consumed (0..1), null when no USD cap. */
  pctUsd: number | null;
  /** Share of the token budget consumed (0..1), null when no token cap. */
  pctTokens: number | null;
}

/** Env names follow the ZELARI_MISSION_MAX_COST / _TOKENS convention. */
export function resolveSessionBudget(env: NodeJS.ProcessEnv = process.env): SessionBudget {
  const maxUsd = parsePositiveFloat(env.ZELARI_SESSION_BUDGET_USD);
  const maxTokens = parsePositiveInt(env.ZELARI_SESSION_BUDGET_TOKENS);
  if (maxUsd === undefined && maxTokens === undefined) return {};
  return { ...(maxUsd !== undefined ? { maxUsd } : {}), ...(maxTokens !== undefined ? { maxTokens } : {}) };
}

function parsePositiveFloat(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export class SessionBudgetTracker {
  private usedUsd = 0;
  private usedTokens = 0;

  constructor(private readonly budget: SessionBudget = {}) {}

  get enabled(): boolean {
    return this.budget.maxUsd !== undefined || this.budget.maxTokens !== undefined;
  }

  /** Idempotent per-turn accumulation; ignores NaN/negative inputs. */
  record(delta: { costUsd?: number; tokens?: number }): void {
    if (Number.isFinite(delta.costUsd) && (delta.costUsd ?? 0) > 0) this.usedUsd += delta.costUsd ?? 0;
    if (Number.isFinite(delta.tokens) && (delta.tokens ?? 0) > 0) this.usedTokens += Math.round(delta.tokens ?? 0);
  }

  status(): BudgetStatus {
    if (!this.enabled) return { state: 'off', usedUsd: this.usedUsd, usedTokens: this.usedTokens, pctUsd: null, pctTokens: null };
    const pctUsd = this.budget.maxUsd !== undefined ? this.usedUsd / this.budget.maxUsd : null;
    const pctTokens = this.budget.maxTokens !== undefined ? this.usedTokens / this.budget.maxTokens : null;
    const worst = Math.max(pctUsd ?? 0, pctTokens ?? 0);
    const state: BudgetState = worst >= 1 ? 'hold' : worst >= 0.8 ? 'warn' : 'ok';
    return { state, usedUsd: round6(this.usedUsd), usedTokens: this.usedTokens, pctUsd, pctTokens };
  }

  /** True when no further provider turn should start. */
  isHold(): boolean {
    return this.status().state === 'hold';
  }
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Process-wide tracker for the interactive session. One TUI process is one
 * session (same lifetime assumption as metrics.jsonl aggregation), so a lazy
 * module singleton is honest here; headless runs keep their own mission caps.
 */
let processTracker: SessionBudgetTracker | undefined;

export function processSessionBudget(env: NodeJS.ProcessEnv = process.env): SessionBudgetTracker {
  if (!processTracker) processTracker = new SessionBudgetTracker(resolveSessionBudget(env));
  return processTracker;
}

/** Test hook: reset the singleton between unit tests. */
export function resetProcessSessionBudget(): void {
  processTracker = undefined;
}

/** Human-facing chip for the status bar; null when the budget is off. */
export function budgetChip(status: BudgetStatus): { label: string; tone: 'green' | 'yellow' | 'red' } | null {
  if (status.state === 'off') return null;
  const pct = Math.max(status.pctUsd ?? 0, status.pctTokens ?? 0);
  const label =
    status.state === 'hold'
      ? 'budget HOLD'
      : `budget ${Math.min(999, Math.round(pct * 100))}%`;
  const tone = status.state === 'hold' ? 'red' : status.state === 'warn' ? 'yellow' : 'green';
  return { label, tone };
}
