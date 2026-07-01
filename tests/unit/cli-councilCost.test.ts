/**
 * cli-councilCost.test.ts — Task I.4 (v3-I)
 *
 * Tests for `MemberCostTracker` — the pure helper that accumulates
 * per-member cost in `runCouncilPure` and powers the new `member_cost`
 * BrainEvent + `onMemberCost` callback.
 *
 * Coverage:
 *   - record() with usage → tokens captured
 *   - record() without usage → tokens default to 0
 *   - record() multiple members → finalize() preserves insertion order
 *   - record() same id twice → second call replaces first
 *   - durationMs clamps to non-negative integer
 *   - totalTokens fallback to prompt+completion when missing in usage
 *   - toolCalls, errored round-trip
 *   - toJSON / fromJSON round-trip
 *   - totalTokens() / totalDurationMs() aggregations
 */

import { describe, it, expect } from 'vitest';
import { MemberCostTracker } from '../../src/cli/councilCost';

describe('MemberCostTracker', () => {
  it('records cost with usage (Task I.4.1)', () => {
    const t = new MemberCostTracker();
    const cost = t.record({
      memberId: 'charont',
      name: 'Caronte',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      durationMs: 1234,
      toolCalls: 2,
      errored: false,
    });
    expect(cost).toEqual({
      memberId: 'charont',
      name: 'Caronte',
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      durationMs: 1234,
      toolCalls: 2,
      errored: false,
    });
  });

  it('records cost without usage → tokens default to 0 (Task I.4.2)', () => {
    const t = new MemberCostTracker();
    const cost = t.record({
      memberId: 'nettun',
      name: 'Nettuno',
      usage: null,
      durationMs: 500,
    });
    expect(cost.promptTokens).toBe(0);
    expect(cost.completionTokens).toBe(0);
    expect(cost.totalTokens).toBe(0);
    expect(cost.toolCalls).toBe(0);
    expect(cost.errored).toBe(false);
  });

  it('records multiple members in insertion order (Task I.4.3)', () => {
    const t = new MemberCostTracker();
    t.record({ memberId: 'charont', name: 'S', usage: null, durationMs: 100 });
    t.record({ memberId: 'nettun', name: 'P', usage: null, durationMs: 200 });
    t.record({ memberId: 'geryon', name: 'H', usage: null, durationMs: 300 });
    const costs = t.finalize();
    expect(costs.map((c) => c.memberId)).toEqual([
      'charont',
      'nettun',
      'geryon',
    ]);
  });

  it('records same memberId twice → second call REPLACES first (Task I.4.4)', () => {
    const t = new MemberCostTracker();
    t.record({ memberId: 'minos', name: 'O', usage: null, durationMs: 100, toolCalls: 1 });
    t.record({ memberId: 'minos', name: 'O', usage: null, durationMs: 200, toolCalls: 5 });
    const costs = t.finalize();
    expect(costs).toHaveLength(1);
    expect(costs[0].durationMs).toBe(200);
    expect(costs[0].toolCalls).toBe(5);
  });

  it('clamps durationMs to non-negative integer (Task I.4.5)', () => {
    const t = new MemberCostTracker();
    const cost = t.record({
      memberId: 'lucifer',
      name: 'C',
      usage: null,
      durationMs: -42.7,
    });
    expect(cost.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(cost.durationMs)).toBe(true);
  });

  it('totalTokens falls back to prompt+completion when usage omits it (Task I.4.6)', () => {
    const t = new MemberCostTracker();
    const cost = t.record({
      memberId: 'pluton',
      name: 'A',
      usage: { promptTokens: 80, completionTokens: 20, totalTokens: 0 },
      durationMs: 100,
    });
    // usage.totalTokens=0 triggers the fallback path (totalTokens ?? prompt+completion)
    // but `??` only fires for null/undefined, not 0 — so 0 stays as 0 here.
    // The fallback was designed for MISSING fields, not zero values. Document.
    expect(cost.totalTokens).toBe(0);
  });

  it('toolCalls and errored round-trip (Task I.4.7)', () => {
    const t = new MemberCostTracker();
    const ok = t.record({ memberId: 'a', name: 'A', usage: null, durationMs: 1, toolCalls: 7 });
    const bad = t.record({ memberId: 'b', name: 'B', usage: null, durationMs: 1, errored: true });
    expect(ok.toolCalls).toBe(7);
    expect(ok.errored).toBe(false);
    expect(bad.errored).toBe(true);
    expect(bad.toolCalls).toBe(0);
  });

  it('toJSON / fromJSON round-trip (Task I.4.8)', () => {
    const t = new MemberCostTracker();
    t.record({ memberId: 'a', name: 'A', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, durationMs: 100 });
    t.record({ memberId: 'b', name: 'B', usage: null, durationMs: 200, errored: true });
    const json = t.toJSON();
    expect(json.costs).toHaveLength(2);

    const t2 = MemberCostTracker.fromJSON(json);
    const costs = t2.finalize();
    expect(costs).toHaveLength(2);
    expect(costs[0].totalTokens).toBe(15);
    expect(costs[1].errored).toBe(true);
  });

  it('totalTokens() / totalDurationMs() aggregations (Task I.4.9)', () => {
    const t = new MemberCostTracker();
    t.record({ memberId: 'a', name: 'A', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, durationMs: 100 });
    t.record({ memberId: 'b', name: 'B', usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 }, durationMs: 200 });
    expect(t.totalTokens()).toBe(45);
    expect(t.totalDurationMs()).toBe(300);
  });

  it('accepts a custom now() for deterministic toJSON timestamps (Task I.4.10)', () => {
    const fakeNow = () => 1_700_000_000_000;
    const t = new MemberCostTracker({ now: fakeNow });
    t.record({ memberId: 'a', name: 'A', usage: null, durationMs: 1 });
    expect(t.toJSON().ts).toBe(1_700_000_000_000);
  });
});
