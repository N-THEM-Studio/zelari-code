/**
 * tools/eval/measuredGate.test.ts — Fase 0 measured comparison tests.
 *
 * Fixtures are synthetic run records (same builder shape as
 * regressionGate.rate.test.ts) with KNOWN pass counts, so every Wilson CI,
 * z-statistic and classification is hand-verifiable.
 */

import { describe, expect, it } from 'vitest';
import { evaluateMeasuredGate, formatMeasuredReport } from './measuredGate.ts';
import { zeroCost } from './cost.ts';
import type { AnchorRunRecord } from './types.ts';

let runSeq = 0;

/** `verified ⇔ result === 'pass'`, mirroring the existing gate test builder. */
function rec(anchorId: string, pass: boolean, costUsd = 0.1): AnchorRunRecord {
  runSeq += 1;
  return {
    runId: `r${runSeq}`,
    anchorId,
    anchorVersion: 1,
    harnessManifestHash: 'h',
    resourcePolicyHash: 'p',
    result: pass ? 'pass' : 'fail',
    verified: pass,
    cost: { ...zeroCost(), modelCostUsd: costUsd, toolCalls: 5, wallMs: 60_000 },
    exitCode: pass ? 0 : 1,
    recordedAt: '2026-01-01T00:00:00Z',
  };
}

/** `passes` verified + `fails` unverified records for one anchor. */
function runs(anchorId: string, passes: number, fails: number, costUsd = 0.1): AnchorRunRecord[] {
  return [
    ...Array.from({ length: passes }, () => rec(anchorId, true, costUsd)),
    ...Array.from({ length: fails }, () => rec(anchorId, false, costUsd)),
  ];
}

describe('anchor classification (Wilson non-overlap)', () => {
  it('today\'s default data (1 run/anchor) is insufficient-n everywhere — the honest default', () => {
    const m = evaluateMeasuredGate({
      baseline: [rec('a1', true)],
      candidate: [rec('a1', false)],
    });
    expect(m.anchors[0].classification).toBe('insufficient-n');
    expect(m.suite.verdict).toBe('insufficient-n');
  });

  it('9/10 → 2/10 with minRuns 3: regression-MEASURED (CIs do not overlap)', () => {
    // baseline 9/10: CI [0.596, 0.982]; candidate 2/10: CI [0.057, 0.510]
    const m = evaluateMeasuredGate({
      baseline: runs('a1', 9, 1),
      candidate: runs('a1', 2, 8),
    });
    expect(m.anchors[0].classification).toBe('regression-measured');
    // Suite: 0.90 vs 0.20 → z ≈ 3.15, p ≈ 0.0017 → measured-worse.
    expect(m.suite.verdict).toBe('measured-worse');
    expect(m.suite.proportion!.pValue).toBeLessThan(0.01);
  });

  it('6/10 → 5/10 with minRuns 3: regression-POSSIBLE (inside the noise band)', () => {
    const m = evaluateMeasuredGate({
      baseline: runs('a1', 6, 4),
      candidate: runs('a1', 5, 5),
    });
    expect(m.anchors[0].classification).toBe('regression-possible');
  });

  it('union semantics (plan §21): anchor gone from the candidate is missing-candidate, never silent', () => {
    const m = evaluateMeasuredGate({
      baseline: runs('gone', 5, 0),
      candidate: runs('new', 5, 0),
    });
    expect(m.anchors.map((a) => [a.anchorId, a.classification])).toEqual([
      ['gone', 'missing-candidate'],
      ['new', 'new-anchor'],
    ]);
  });

  it('all-pass both sides → both-pass; all-fail both sides → both-fail', () => {
    const ok = evaluateMeasuredGate({ baseline: runs('a', 4, 0), candidate: runs('a', 4, 0) });
    expect(ok.anchors[0].classification).toBe('both-pass');
    const bad = evaluateMeasuredGate({ baseline: runs('a', 0, 4), candidate: runs('a', 0, 4) });
    expect(bad.anchors[0].classification).toBe('both-fail');
    // both-fail also yields no proportion test (constant pooled outcome)
    expect(bad.suite.proportion).toBeNull();
    expect(bad.suite.verdict).toBe('no-significant-difference');
  });
});

describe('suite verdict (two-proportion z-test)', () => {
  it('63/70 vs 66/70 → z ≈ −0.94, p ≈ 0.35 → no significant difference', () => {
    const m = evaluateMeasuredGate({
      baseline: runs('suite', 63, 7),
      candidate: runs('suite', 66, 4),
    });
    expect(m.suite.proportion!.z).toBeCloseTo(-0.94, 2);
    expect(m.suite.proportion!.pValue).toBeGreaterThan(0.3);
    expect(m.suite.proportion!.pValue).toBeLessThan(0.4);
    expect(m.suite.verdict).toBe('no-significant-difference');
  });

  it('70/100 vs 84/100 → p < 0.05, candidate above → measured-better', () => {
    const m = evaluateMeasuredGate({
      baseline: runs('suite', 70, 30),
      candidate: runs('suite', 84, 16),
    });
    expect(m.suite.verdict).toBe('measured-better');
  });

  it('empty candidate side → insufficient-n, never a fabricated verdict', () => {
    const m = evaluateMeasuredGate({ baseline: runs('a', 5, 0), candidate: [] });
    expect(m.suite.verdict).toBe('insufficient-n');
    expect(m.suite.candidate).toBeNull();
  });
});

describe('cost effect size', () => {
  it('Cohen d over per-run unified cost: [0.08,0.10,0.12] vs [0.18,0.20,0.22] → d = 5', () => {
    const m = evaluateMeasuredGate({
      baseline: [rec('c', true, 0.08), rec('c', true, 0.1), rec('c', true, 0.12)],
      candidate: [rec('c', true, 0.18), rec('c', true, 0.2), rec('c', true, 0.22)],
    });
    expect(m.suite.costPerRunD).toBeCloseTo(5, 10);
    expect(m.suite.baselineCostMean).toBeCloseTo(0.1, 10);
    expect(m.suite.candidateCostMean).toBeCloseTo(0.2, 10);
  });

  it('fewer than 2 records on a side → null (spread unmeasured)', () => {
    const m = evaluateMeasuredGate({ baseline: [rec('c', true)], candidate: [rec('c', true)] });
    expect(m.suite.costPerRunD).toBeNull();
  });
});

describe('formatMeasuredReport', () => {
  it('renders verdict, classifications and the advisory note', () => {
    const m = evaluateMeasuredGate({
      baseline: runs('a1', 9, 1),
      candidate: runs('a1', 2, 8),
    });
    const text = formatMeasuredReport(m, { baselineHash: 'deadbeefdeadbeef', candidateHash: 'cafebabecafebabe' });
    expect(text).toContain('VERDICT:');
    expect(text).toContain('measured-worse');
    expect(text).toMatch(/regression-measured:\s+a1/);
    expect(text).toMatch(/insufficient-n:\s+none/);
    expect(text).toContain('never implies promotion');
    expect(text).toContain('deadbeef');
  });
});
