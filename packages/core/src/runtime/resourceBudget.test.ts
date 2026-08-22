/**
 * runtime/resourceBudget.test.ts — 2.6 Track B core tests (doc §26.2/26.3/26.4).
 */

import { describe, expect, it } from 'vitest';
import {
  budgetPressure,
  canSpendOutsideReserve,
  computeBudget,
  isVerificationReserveProtected,
  ledgerDeltaFor,
  usageFromLedger,
} from './resourceBudget.js';
import { defaultResourcePolicy, resourcePolicyHash, ResourcePolicySchema } from './resourcePolicy.js';

const POLICY = defaultResourcePolicy('kraken/v1'); // 40 / 6 / 4 / 900s

describe('computeBudget', () => {
  it('keeps remaining = limit - used; overuse is REAL, never clamped (2.6.1 §9)', () => {
    const b = computeBudget(POLICY, { toolCallsUsed: 27 });
    expect(b.toolCalls).toEqual({ limit: 40, used: 27, remaining: 13, overrun: 0 });
    const over = computeBudget(POLICY, { toolCallsUsed: 55 });
    expect(over.toolCalls.used).toBe(55); // real spend
    expect(over.toolCalls.remaining).toBe(0);
    expect(over.toolCalls.overrun).toBe(15); // 55 - 40
  });

  it('keeps reserves non-negative and stages explicit', () => {
    const b = computeBudget(POLICY, { toolCallsUsed: 1 }, 'verify');
    expect(b.reserve).toEqual({ verification: 6, repair: 4 });
    expect(b.stage).toBe('verify');
  });
});

describe('usageFromLedger (no double-count)', () => {
  it('sums deltas once per seq — replay idempotent', () => {
    const entries = [
      { seq: 1, reason: 'tool-call', delta: { toolCalls: 1 } },
      { seq: 2, reason: 'tool-call', delta: { toolCalls: 1 } },
      { seq: 2, reason: 'tool-call', delta: { toolCalls: 1 } }, // replay dup
      { seq: 3, reason: 'model-turn', delta: { tokens: 500 } },
    ] as const;
    const u = usageFromLedger(entries);
    expect(u.toolCallsUsed).toBe(2);
    expect(u.tokensUsed).toBe(500);
  });

  it('maps reasons deterministically', () => {
    expect(ledgerDeltaFor('tool-call')).toEqual({ toolCalls: 1 });
    expect(ledgerDeltaFor('timeout')).toEqual({});
  });
});

describe('budgetPressure', () => {
  it('walks ample → normal → constrained → critical as usage grows', () => {
    const at = (used: number) => budgetPressure(computeBudget(POLICY, { toolCallsUsed: used }), POLICY);
    expect(at(5)).toBe('ample'); // usable 29/34
    expect(at(20)).toBe('normal'); // usable 14/34
    expect(at(30)).toBe('constrained'); // usable 4/34
    expect(at(36)).toBe('critical'); // usable 0
  });
});

describe('verification reserve protection', () => {
  it('activates exactly at remaining <= verificationReserve', () => {
    expect(isVerificationReserveProtected(computeBudget(POLICY, { toolCallsUsed: 33 }))).toBe(false); // remaining 7 > 6
    expect(isVerificationReserveProtected(computeBudget(POLICY, { toolCallsUsed: 34 }))).toBe(true); // remaining 6 == 6
  });

  it('blocks non-verify spending inside the reserve', () => {
    const inside = computeBudget(POLICY, { toolCallsUsed: 36 });
    expect(canSpendOutsideReserve(inside, 1)).toBe(false);
    const outside = computeBudget(POLICY, { toolCallsUsed: 20 });
    expect(canSpendOutsideReserve(outside, 10)).toBe(true);
  });
});

describe('resourcePolicyHash', () => {
  it('is behavioural: changing the reserve changes the hash', () => {
    const a = resourcePolicyHash(POLICY);
    const b: typeof POLICY = ResourcePolicySchema.parse({ ...POLICY, reserve: { verification: 8, repair: 4 } });
    expect(resourcePolicyHash(b)).not.toBe(a);
    expect(resourcePolicyHash(POLICY)).toBe(a);
  });
});
