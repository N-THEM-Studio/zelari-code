/**
 * tools/eval/stats.test.ts — Fase 0 measurement layer unit tests.
 *
 * Every expected value below was derived by hand from the formulas in
 * stats.ts (deterministic math, no fixtures). If an assertion moves, the
 * formula moved — not the noise.
 */

import { describe, expect, it } from 'vitest';
import {
  Z95,
  cohensD,
  erf,
  meanCi95,
  minRunsPerAnchor,
  normalCdf,
  summarize,
  twoProportionTest,
  wilsonInterval,
} from './stats.ts';

describe('summarize', () => {
  it('computes sample mean/variance/stdev (n-1)', () => {
    const s = summarize([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(s.n).toBe(8);
    expect(s.mean).toBe(5);
    expect(s.variance).toBeCloseTo(32 / 7, 10);
    expect(s.stdev).toBeCloseTo(Math.sqrt(32 / 7), 10);
  });

  it('degrades honestly: empty → zeros, single sample → no spread claim', () => {
    expect(summarize([])).toEqual({ n: 0, mean: 0, variance: 0, stdev: 0 });
    expect(summarize([3])).toEqual({ n: 1, mean: 3, variance: 0, stdev: 0 });
  });
});

describe('wilsonInterval', () => {
  it('0/10 → [0, ~0.2775]: zero passes never claims failure is impossible', () => {
    const ci = wilsonInterval(0, 10)!;
    expect(ci).not.toBeNull();
    expect(ci.lo).toBe(0);
    expect(ci.hi).toBeCloseTo(0.2775, 3);
  });

  it('10/10 → [~0.7225, 1] and mirrors 0/10 (symmetry)', () => {
    const ci = wilsonInterval(10, 10)!;
    expect(ci.lo).toBeCloseTo(0.7225, 3);
    // analytic hi is exactly 1; the float path lands 1 ULP below → assert to 1e-12
    expect(ci.hi).toBeCloseTo(1, 12);
    expect(ci.lo).toBeCloseTo(1 - wilsonInterval(0, 10)!.hi, 6);
  });

  it('9/10 → [~0.596, ~0.982]', () => {
    const ci = wilsonInterval(9, 10)!;
    expect(ci.lo).toBeCloseTo(0.5959, 3);
    expect(ci.hi).toBeCloseTo(0.9822, 3);
  });

  it('returns null on invalid input', () => {
    expect(wilsonInterval(1, 0)).toBeNull();
    expect(wilsonInterval(-1, 10)).toBeNull();
    expect(wilsonInterval(11, 10)).toBeNull();
    expect(wilsonInterval(1, 1.5)).toBeNull();
  });
});

describe('erf / normalCdf', () => {
  it('matches reference points within the documented 1.5e-7 error', () => {
    // A&S 7.1.26 at x=0 leaves a ~1e-9 residue — inside the documented 1.5e-7 bound
    expect(erf(0)).toBeCloseTo(0, 8);
    // normalCdf(0) = 0.5·(1 + erf(0)) inherits the ~5e-10 half-residue → assert to 1e-8
    expect(normalCdf(0)).toBeCloseTo(0.5, 8);
    expect(normalCdf(Z95)).toBeCloseTo(0.975, 5);
    expect(normalCdf(-Z95)).toBeCloseTo(0.025, 5);
  });
});

describe('twoProportionTest', () => {
  it('70/100 vs 84/100 → z ≈ −2.35, p ≈ 0.019 (significant)', () => {
    const t = twoProportionTest(70, 100, 84, 100)!;
    expect(t).not.toBeNull();
    expect(t.z).toBeCloseTo(-2.35, 2);
    expect(t.pValue).toBeGreaterThan(0.01);
    expect(t.pValue).toBeLessThan(0.05);
  });

  it('identical rates → z = 0, p = 1', () => {
    const t = twoProportionTest(5, 10, 5, 10)!;
    expect(t.z).toBe(0);
    // p inherits the erf(0) ≈ 1e-9 residue → 2(1 − Φ(0)) = 1 − ~1e-9
    expect(t.pValue).toBeCloseTo(1, 8);
  });

  it('both sides constant → null (never fabricate a p-value)', () => {
    expect(twoProportionTest(0, 10, 0, 10)).toBeNull();
    expect(twoProportionTest(10, 10, 10, 10)).toBeNull();
  });

  it('rejects invalid counts', () => {
    expect(twoProportionTest(-1, 10, 0, 10)).toBeNull();
    expect(twoProportionTest(5, 0, 5, 10)).toBeNull();
  });
});

describe('meanCi95', () => {
  it('classic dataset: mean 5, t(7)=2.365 → [~3.212, ~6.788]', () => {
    const ci = meanCi95([2, 4, 4, 4, 5, 5, 7, 9])!;
    expect(ci.n).toBe(8);
    expect(ci.mean).toBe(5);
    // df = n−1 = 7 → t₀.₀₂₅,₇ = 2.365 (2.306 is t(8)); half = 2.365·√(32/7)/√8 = 1.7878
    expect(ci.lo).toBeCloseTo(3.2122, 3);
    expect(ci.hi).toBeCloseTo(6.7878, 3);
  });

  it('single sample → null (nothing measured about spread)', () => {
    expect(meanCi95([3])).toBeNull();
    expect(meanCi95([])).toBeNull();
  });

  it('zero spread → degenerate interval at the mean, not null', () => {
    const ci = meanCi95([4, 4, 4])!;
    expect(ci.lo).toBe(4);
    expect(ci.hi).toBe(4);
  });
});

describe('cohensD', () => {
  it('equal spreads, means 3 apart with sd 2 → d = 1.5 (b above a)', () => {
    expect(cohensD([10, 12, 14], [13, 15, 17])).toBeCloseTo(1.5, 10);
  });

  it('direction: negative when b is below a; null on empty input', () => {
    expect(cohensD([13, 15, 17], [10, 12, 14])).toBeCloseTo(-1.5, 10);
    expect(cohensD([], [1])).toBeNull();
    expect(cohensD([1], [])).toBeNull();
  });

  it('zero spread on both sides → d = 0 (identical constant costs)', () => {
    expect(cohensD([2, 2], [2, 2])).toBe(0);
  });
});

describe('minRunsPerAnchor', () => {
  it('detecting a ±10pp delta at p0=0.5 needs ~389 runs/side', () => {
    // (1.96+0.8416)² · (0.45·0.55 + 0.55·0.45) / 0.01 = 7.8489 · 0.495 / 0.01 = 388.5 → 389
    expect(minRunsPerAnchor(0.5, 0.1)).toBe(389);
  });

  it('a ±20pp delta at p0=0.5 needs ~95 runs/side; delta 0 → Infinity', () => {
    expect(minRunsPerAnchor(0.5, 0.2)).toBe(95);
    expect(minRunsPerAnchor(0.9, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it('the lesson Fase 0 exists for: 81→84 deltas are undetectable at n=1', () => {
    const n = minRunsPerAnchor(0.81, 0.03);
    expect(n).toBeGreaterThan(2000);
  });
});
