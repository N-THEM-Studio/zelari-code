/**
 * modelReputation tests — t29 (§15–16). Locks:
 *  - aggregation math: perfect/zero/mixed buckets, decay across time
 *    (half-life 30d, deterministic with an injected `now`), null-vs-zero
 *    for absent cost/latency data;
 *  - rankForRepo: score ordering, REPUTATION_MIN_SAMPLE threshold ⇒ null,
 *    deterministic tie-break (score desc, provider asc, model asc);
 *  - reputationFamilyPick: pool filtering + fallback-to-null semantics;
 *  - record building: outcome mapping (verified/failed/repaired/
 *    review-rejected, unknown-verdict ⇒ failed) and firstPass.
 */
import { describe, expect, it } from 'vitest';
import {
  aggregate,
  COST_EPSILON_USD,
  decayWeight,
  rankForRepo,
  REPUTATION_HALF_LIFE_MS,
  REPUTATION_MIN_SAMPLE,
  reputationFamilyPick,
  reputationRecordFromNodeRun,
  type ReputationOutcome,
  type ReputationRecord,
} from './modelReputation.js';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function rec(over: Partial<ReputationRecord> & { model: string }): ReputationRecord {
  const outcome: ReputationOutcome = over.outcome ?? 'verified';
  const base: ReputationRecord = {
    ts: NOW,
    repo: 'zelari-code',
    model: over.model,
    provider: 'prov',
    role: 'verify',
    language: null,
    outcome,
    firstPass: outcome === 'verified',
    repairCount: 0,
    costUsd: null,
    latencyMs: null,
  };
  return { ...base, ...over, outcome };
}

describe('decayWeight', () => {
  it('is 1 at age 0, halves at the half-life, and clamps future timestamps', () => {
    expect(decayWeight(NOW, NOW)).toBe(1);
    expect(decayWeight(NOW - REPUTATION_HALF_LIFE_MS, NOW)).toBeCloseTo(0.5, 12);
    expect(decayWeight(NOW + 5_000, NOW)).toBe(1);
  });
});

describe('aggregate', () => {
  it('empty bucket ⇒ sample 0 with null averages (absence ≠ zero)', () => {
    const s = aggregate([], { repo: 'zelari-code' }, NOW);
    expect(s).toEqual({
      sample: 0,
      verifiedRate: 0,
      firstPassRate: 0,
      avgRepairs: 0,
      avgCostUsd: null,
      avgLatencyMs: null,
      rejectionRate: 0,
    });
  });

  it('perfect records ⇒ verifiedRate 1; zero records ⇒ 0', () => {
    const good = Array.from({ length: 3 }, () => rec({ model: 'm' }));
    const bad = [rec({ model: 'm', outcome: 'failed', firstPass: false, repairCount: 2 })];
    expect(aggregate(good, { repo: 'zelari-code' }, NOW).verifiedRate).toBe(1);
    expect(aggregate(bad, { repo: 'zelari-code' }, NOW).verifiedRate).toBe(0);
  });

  it('mixed bucket computes all rates and weighted averages', () => {
    const records = [
      rec({ model: 'm', costUsd: 0.1, latencyMs: 1000 }),
      rec({ model: 'm', outcome: 'repaired', firstPass: false, repairCount: 1, costUsd: 0.3, latencyMs: 3000 }),
      rec({ model: 'm', outcome: 'review-rejected', costUsd: 0.2, latencyMs: 2000 }),
    ];
    const s = aggregate(records, { repo: 'zelari-code' }, NOW);
    expect(s.sample).toBe(3);
    expect(s.verifiedRate).toBeCloseTo(1 / 3, 12);
    // Only the verified run was first-pass (repaired + rejected were not).
    expect(s.firstPassRate).toBeCloseTo(1 / 3, 12);
    expect(s.rejectionRate).toBeCloseTo(1 / 3, 12);
    expect(s.avgRepairs).toBeCloseTo(1 / 3, 12);
    expect(s.avgCostUsd).toBeCloseTo(0.2, 12);
    expect(s.avgLatencyMs).toBeCloseTo(2000, 12);
  });

  it('applies recency decay: half-life-old failures weigh half of fresh runs', () => {
    const records = [
      ...Array.from({ length: 3 }, () => rec({ model: 'm' })), // fresh verified, w = 1
      ...Array.from({ length: 6 }, () => rec({ model: 'm', outcome: 'failed', ts: NOW - REPUTATION_HALF_LIFE_MS })),
    ];
    // Σw = 3·1 + 6·0.5 = 6, verified weight 3 ⇒ exactly 0.5.
    const s = aggregate(records, { repo: 'zelari-code' }, NOW);
    expect(s.verifiedRate).toBeCloseTo(0.5, 12);
    expect(s.sample).toBe(9); // sample stays a raw count
  });

  it('buckets by repo, role, and model independently', () => {
    const records = [
      rec({ model: 'm' }), // matches
      rec({ model: 'm', role: 'general' }),
      rec({ model: 'm', repo: 'other' }),
      rec({ model: 'other-model' }),
    ];
    expect(aggregate(records, { repo: 'zelari-code', role: 'verify', model: 'm' }, NOW).sample).toBe(1);
    expect(aggregate(records, { repo: 'zelari-code', role: 'general' }, NOW).sample).toBe(1);
    expect(aggregate(records, { repo: 'other' }, NOW).sample).toBe(1);
  });
});

describe('rankForRepo', () => {
  const CANDIDATES = [
    { provider: 'a', model: 'cheap' },
    { provider: 'b', model: 'pricey' },
  ];

  it('returns null when no candidate reaches REPUTATION_MIN_SAMPLE', () => {
    const records = Array.from({ length: REPUTATION_MIN_SAMPLE - 1 }, () => rec({ model: 'cheap', costUsd: 1 }));
    expect(rankForRepo(records, { repo: 'zelari-code', candidates: CANDIDATES }, NOW)).toBeNull();
  });

  it('ranks by verifiedRate / avgCostUsd: reliable+cheap beats pricey', () => {
    const records = [
      ...Array.from({ length: REPUTATION_MIN_SAMPLE }, () => rec({ model: 'cheap', costUsd: 0.5 })),
      ...Array.from({ length: REPUTATION_MIN_SAMPLE }, () =>
        rec({ model: 'pricey', provider: 'b', costUsd: 5 })),
    ];
    const ranked = rankForRepo(records, { repo: 'zelari-code', candidates: CANDIDATES }, NOW);
    expect(ranked).not.toBeNull();
    expect(ranked!.map((r) => r.model)).toEqual(['cheap', 'pricey']);
    expect(ranked![0]!.score).toBeCloseTo(1 / 0.5, 12);
    expect(ranked![1]!.score).toBeCloseTo(1 / 5, 12);
  });

  it('quality dominates: a failing cheap model ranks below a verified pricey one', () => {
    const records = [
      ...Array.from({ length: REPUTATION_MIN_SAMPLE }, () =>
        rec({ model: 'cheap', outcome: 'failed', costUsd: 0.01 })),
      ...Array.from({ length: REPUTATION_MIN_SAMPLE }, () =>
        rec({ model: 'pricey', provider: 'b', costUsd: 10 })),
    ];
    const ranked = rankForRepo(records, { repo: 'zelari-code', candidates: CANDIDATES }, NOW)!;
    expect(ranked.map((r) => r.model)).toEqual(['pricey', 'cheap']);
    expect(ranked[1]!.score).toBe(0);
  });

  it('breaks score ties deterministically (provider asc, then model asc)', () => {
    const records = [
      ...Array.from({ length: REPUTATION_MIN_SAMPLE }, () => rec({ model: 'zz', provider: 'b', costUsd: 1 })),
      ...Array.from({ length: REPUTATION_MIN_SAMPLE }, () => rec({ model: 'aa', provider: 'a', costUsd: 1 })),
    ];
    const ranked = rankForRepo(
      records,
      { repo: 'zelari-code', candidates: [{ provider: 'b', model: 'zz' }, { provider: 'a', model: 'aa' }] },
      NOW,
    )!;
    expect(ranked.map((r) => r.model)).toEqual(['aa', 'zz']); // equal score ⇒ provider 'a' < 'b'
  });

  it('cost-unknown buckets use the epsilon denominator instead of crashing', () => {
    const records = Array.from({ length: REPUTATION_MIN_SAMPLE }, () => rec({ model: 'cheap' }));
    const ranked = rankForRepo(records, { repo: 'zelari-code', candidates: [CANDIDATES[0]!] }, NOW)!;
    expect(ranked[0]!.score).toBeCloseTo(1 / COST_EPSILON_USD, 6);
  });
});

describe('reputationFamilyPick', () => {
  it('returns the pool-filtered top pick, null on unknown repo/empty records', () => {
    const records = Array.from({ length: REPUTATION_MIN_SAMPLE }, () => rec({ model: 'm1', costUsd: 1 }));
    const pool = [{ provider: 'prov', model: 'm1' }, { provider: 'prov', model: 'm2' }];
    expect(reputationFamilyPick(records, pool, 'zelari-code')).toEqual({ provider: 'prov', model: 'm1' });
    expect(reputationFamilyPick(records, pool, null)).toBeNull();
    expect(reputationFamilyPick([], pool, 'zelari-code')).toBeNull();
    expect(reputationFamilyPick(records, pool.slice(1), 'zelari-code')).toBeNull(); // m2 under-sampled
  });
});

describe('reputationRecordFromNodeRun (executor seam mapping)', () => {
  const base = {
    repo: 'zelari-code',
    role: 'general',
    kind: 'general',
    reviewerVerdict: null,
    repairCount: 0,
    model: 'm',
    provider: null,
    costUsd: 0.25,
    latencyMs: 1500,
  };

  it('first-pass success ⇒ verified + firstPass', () => {
    const r = reputationRecordFromNodeRun({ ...base, ok: true });
    expect(r.outcome).toBe('verified');
    expect(r.firstPass).toBe(true);
  });

  it('success after retries ⇒ repaired, not firstPass', () => {
    const r = reputationRecordFromNodeRun({ ...base, ok: true, repairCount: 2 });
    expect(r.outcome).toBe('repaired');
    expect(r.firstPass).toBe(false);
    expect(r.repairCount).toBe(2);
  });

  it('failure ⇒ failed, not firstPass', () => {
    const r = reputationRecordFromNodeRun({ ...base, ok: false });
    expect(r.outcome).toBe('failed');
    expect(r.firstPass).toBe(false);
  });

  it('reviewer kinds map by verdict: fail ⇒ review-rejected, unknown ⇒ failed (unknown ≠ pass)', () => {
    const verify = { ...base, role: 'verify', kind: 'verify', ok: true };
    expect(reputationRecordFromNodeRun({ ...verify, reviewerVerdict: 'pass' }).outcome).toBe('verified');
    expect(reputationRecordFromNodeRun({ ...verify, reviewerVerdict: 'fail' }).outcome).toBe('review-rejected');
    expect(reputationRecordFromNodeRun({ ...verify, reviewerVerdict: 'unknown' }).outcome).toBe('failed');
    // spec/conformance run as verify agents but keep their own kind bucket.
    expect(reputationRecordFromNodeRun({ ...base, kind: 'spec', role: 'verify', ok: true, reviewerVerdict: 'fail' }).outcome)
      .toBe('review-rejected');
  });

  it('carries identity fields verbatim and defaults ts to a finite epoch', () => {
    const r = reputationRecordFromNodeRun({ ...base, ok: true });
    expect(r.repo).toBe('zelari-code');
    expect(r.model).toBe('m');
    expect(r.provider).toBeNull();
    expect(r.language).toBeNull();
    expect(Number.isFinite(r.ts)).toBe(true);
  });
});
