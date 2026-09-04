import { afterEach, describe, expect, it } from 'vitest';
import {
  budgetChip,
  SessionBudgetTracker,
  resolveSessionBudget,
  resetProcessSessionBudget,
} from './costBudget.js';

afterEach(() => resetProcessSessionBudget());

describe('resolveSessionBudget', () => {
  it('defaults to off with no env', () => {
    expect(resolveSessionBudget({})).toEqual({});
  });

  it('parses valid USD and token caps', () => {
    expect(resolveSessionBudget({ ZELARI_SESSION_BUDGET_USD: '2.5', ZELARI_SESSION_BUDGET_TOKENS: '100000' }))
      .toEqual({ maxUsd: 2.5, maxTokens: 100000 });
  });

  it('ignores invalid values (fail-open)', () => {
    expect(resolveSessionBudget({ ZELARI_SESSION_BUDGET_USD: 'abc', ZELARI_SESSION_BUDGET_TOKENS: '-5' })).toEqual({});
  });
});

describe('SessionBudgetTracker', () => {
  it('is off without caps and never holds', () => {
    const t = new SessionBudgetTracker();
    t.record({ costUsd: 999, tokens: 10_000_000 });
    expect(t.status().state).toBe('off');
    expect(t.isHold()).toBe(false);
    expect(budgetChip(t.status())).toBeNull();
  });

  it('accumulates cost and tokens across turns', () => {
    const t = new SessionBudgetTracker({ maxUsd: 1 });
    t.record({ costUsd: 0.25, tokens: 100 });
    t.record({ costUsd: 0.35, tokens: 50 });
    expect(t.status().usedUsd).toBeCloseTo(0.6, 6);
    expect(t.status().usedTokens).toBe(150);
    expect(t.status().state).toBe('ok');
  });

  it('warns at >=80% and holds at >=100% of the USD cap', () => {
    const t = new SessionBudgetTracker({ maxUsd: 1 });
    t.record({ costUsd: 0.79 });
    expect(t.status().state).toBe('ok');
    t.record({ costUsd: 0.01 });
    expect(t.status().state).toBe('warn');
    t.record({ costUsd: 0.2 });
    expect(t.status().state).toBe('hold');
    expect(t.isHold()).toBe(true);
  });

  it('holds on the token cap independently of USD', () => {
    const t = new SessionBudgetTracker({ maxTokens: 1000 });
    t.record({ tokens: 1001 });
    expect(t.status().state).toBe('hold');
  });

  it('ignores non-finite or negative records', () => {
    const t = new SessionBudgetTracker({ maxUsd: 1 });
    t.record({ costUsd: Number.NaN, tokens: -5 });
    t.record({ costUsd: -1 });
    expect(t.status().usedUsd).toBe(0);
    expect(t.status().usedTokens).toBe(0);
  });

  it('chip reflects warn/hold states', () => {
    const t = new SessionBudgetTracker({ maxUsd: 1 });
    t.record({ costUsd: 0.85 });
    expect(budgetChip(t.status())).toEqual({ label: 'budget 85%', tone: 'yellow' });
    t.record({ costUsd: 0.2 });
    expect(budgetChip(t.status())).toEqual({ label: 'budget HOLD', tone: 'red' });
  });
});
