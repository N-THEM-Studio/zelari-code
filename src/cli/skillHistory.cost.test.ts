/**
 * t143 — SkillStats.estimatedCostUsd: the per-skill cost estimate reuses
 * modelPricing.calculateCost (blended token count × the model's INPUT rate).
 * Pins the arithmetic with a KNOWN price so a regression to "cost always 0"
 * or an accidental pricing change fails here, not in the UI.
 */
import { describe, expect, it } from 'vitest';
import { getSkillStats, type SkillHistoryRecord } from './skillHistory.js';

function rec(over: Partial<SkillHistoryRecord>): SkillHistoryRecord {
  return { ts: 1, skillId: 'coder-debug', invocationId: 'i1', ok: true, ...over };
}

describe('getSkillStats — estimatedCostUsd (t143)', () => {
  it('estimates cost from totalTokens at the model INPUT rate', () => {
    const records = [rec({ tokensUsed: 1_000_000 }), rec({ tokensUsed: 500_000, ok: false })];
    // grok-4-fast lists input at $0.20 per 1M tokens.
    const stats = getSkillStats(records, undefined, undefined, 'grok-4-fast');
    expect(stats.totalTokens).toBe(1_500_000);
    expect(stats.estimatedCostUsd).toBeCloseTo(0.3, 6);
  });

  it('defaults to the mid-tier DEFAULT_RATE when no model is given, and 0 with no records', () => {
    expect(getSkillStats([]).estimatedCostUsd).toBe(0);
    // DEFAULT_RATE input is $1.00 per 1M tokens.
    const stats = getSkillStats([rec({ tokensUsed: 2_000_000 })]);
    expect(stats.estimatedCostUsd).toBeCloseTo(2, 6);
  });

  it('missing tokensUsed records cost nothing (never NaN)', () => {
    const stats = getSkillStats([rec({}), rec({ tokensUsed: undefined })], 'coder-debug');
    expect(stats.estimatedCostUsd).toBe(0);
  });
});
