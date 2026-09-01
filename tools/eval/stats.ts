/**
 * tools/eval/stats.ts — pure statistics for measured eval comparisons
 * (Fase 0, .zelari/fase0-measurement/PLAN.md).
 *
 * Point estimates are noise with verbose process: an 81→84 solve-rate move
 * on LLM-based anchors is indistinguishable from run-to-run variance until
 * someone measures the variance. This module is the measurement layer every
 * later evolution stage (evidence → candidates → selection) must stand on.
 *
 * Deliberate choices:
 *  - Wilson score intervals for proportions (small-N honest; Wald is not).
 *  - Two-proportion z-test (pooled) for suite-level solve-rate deltas.
 *  - t-based 95% CI for continuous metrics (cost, wall time) via a small
 *    t-table; normal approximation above df 60.
 *  - Cohen's d for effect size — a "significant" 0.2% cost win is irrelevant.
 *  - Zero deps (AGENTS.MD): std math only. No RNG anywhere → deterministic.
 */

export interface SampleSummary {
  n: number;
  mean: number;
  /** Sample variance (n-1 denominator); 0 for n < 2. */
  variance: number;
  stdev: number;
}

export function summarize(values: readonly number[]): SampleSummary {
  const n = values.length;
  if (n === 0) return { n: 0, mean: 0, variance: 0, stdev: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { n, mean, variance: 0, stdev: 0 };
  const variance = values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / (n - 1);
  return { n, mean, variance, stdev: Math.sqrt(variance) };
}

/** z for a two-sided 95% confidence level. */
export const Z95 = 1.959963984540054;

/**
 * Wilson score interval for a binomial proportion. Returns null on invalid
 * input (n<=0, non-integer n, passes outside [0,n]). Clamped to [0,1].
 */
export function wilsonInterval(
  passes: number,
  n: number,
  z: number = Z95,
): { lo: number; hi: number } | null {
  if (n <= 0 || !Number.isInteger(n) || passes < 0 || passes > n) return null;
  const p = passes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

/** Abramowitz & Stegun 7.1.26 erf approximation (|eps| ≤ 1.5e-7). */
export function erf(x: number): number {
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429,
    p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/**
 * Two-proportion z-test (pooled variance). x1/n1 vs x2/n2.
 * Returns null when the test is undefined: invalid counts, or a pooled
 * proportion of exactly 0 or 1 (both sides constant → zero standard error;
 * report "no test possible", never a fabricated p-value). Note: when the
 * pooled proportion is constant the two rates are necessarily equal, so
 * callers may treat null as "no detectable difference", not as "missing".
 */
export function twoProportionTest(
  x1: number,
  n1: number,
  x2: number,
  n2: number,
): { z: number; pValue: number } | null {
  if (n1 <= 0 || n2 <= 0 || x1 < 0 || x2 < 0 || x1 > n1 || x2 > n2) return null;
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (se === 0) return null;
  const z = (p1 - p2) / se;
  return { z, pValue: 2 * (1 - normalCdf(Math.abs(z))) };
}

/** Two-sided 95% t critical values by degrees of freedom (≤60), then normal. */
const T95: ReadonlyArray<[df: number, t: number]> = [
  [1, 12.706],
  [2, 4.303],
  [3, 3.182],
  [4, 2.776],
  [5, 2.571],
  [6, 2.447],
  [7, 2.365],
  [8, 2.306],
  [9, 2.262],
  [10, 2.228],
  [12, 2.179],
  [15, 2.131],
  [20, 2.086],
  [25, 2.06],
  [30, 2.042],
  [40, 2.021],
  [60, 2.0],
];

function t95For(df: number): number {
  if (df > 60) return Z95;
  // Largest tabulated df ≤ df (conservative: larger t) — df ≥ 1 guaranteed by caller.
  let hit = T95[0];
  for (const row of T95) if (row[0] <= df) hit = row;
  return hit[1];
}

export interface MeanCi {
  n: number;
  mean: number;
  stdev: number;
  lo: number;
  hi: number;
}

/**
 * 95% CI for a mean via the t distribution. Null when fewer than 2 samples
 * (a single sample measures nothing about spread). Zero-spread samples get
 * a degenerate [mean, mean] interval — that IS the honest measurement.
 */
export function meanCi95(values: readonly number[]): MeanCi | null {
  if (values.length < 2) return null;
  const { n, mean, stdev } = summarize(values);
  if (stdev === 0) return { n, mean, stdev, lo: mean, hi: mean };
  const half = (t95For(n - 1) * stdev) / Math.sqrt(n);
  return { n, mean, stdev, lo: mean - half, hi: mean + half };
}

/** Cohen's d (pooled sample stdev), standardized as mean(b) − mean(a). Null if either side is empty. */
export function cohensD(a: readonly number[], b: readonly number[]): number | null {
  if (a.length === 0 || b.length === 0) return null;
  const sa = summarize(a);
  const sb = summarize(b);
  const dof = sa.n + sb.n - 2;
  if (dof < 1) return null;
  const pooledVar = ((sa.n - 1) * sa.variance + (sb.n - 1) * sb.variance) / dof;
  if (pooledVar === 0) return 0;
  return (sb.mean - sa.mean) / Math.sqrt(pooledVar);
}

/**
 * Runs per side needed to detect a pass-rate delta of `minDetectableDelta`
 * at a baseline rate `p0` (two-proportion sample size, α=0.05, power≈0.80).
 * Infinity when delta ≤ 0 (undetectable by construction). Rule of thumb,
 * not a promise — the point is orders of magnitude, not decimals.
 */
export function minRunsPerAnchor(
  p0: number,
  minDetectableDelta: number,
  opts?: { alphaZ?: number; powerZ?: number },
): number {
  const za = opts?.alphaZ ?? Z95;
  const zb = opts?.powerZ ?? 0.8416212335729143; // Φ⁻¹(0.80)
  const delta = Math.abs(minDetectableDelta);
  if (delta <= 0) return Number.POSITIVE_INFINITY;
  const p1 = Math.min(Math.max(p0 - delta / 2, 0), 1);
  const p2 = Math.min(Math.max(p0 + delta / 2, 0), 1);
  const n = ((za + zb) ** 2 * (p1 * (1 - p1) + p2 * (1 - p2))) / (delta * delta);
  return Math.ceil(n);
}
