/**
 * tools/eval/measuredGate.ts — variance-aware comparison of baseline vs
 * candidate anchor runs (Fase 0, .zelari/fase0-measurement/PLAN.md).
 *
 * ADVERSARIAL to point-estimate promotion: a delta that fits inside
 * run-to-run noise is reported as such, never as a win. Advisory-only —
 * this module NEVER flips a retention decision on its own; turning it into
 * a blocking policy field is Fase 0.1 (mirroring how
 * minVerificationGatePassRate rolled out: opt-in, presets stay unset).
 *
 * Semantics aligned with the existing gate:
 *  - rates measured over `r.verified` (strict signal, §P1.2), not `result`;
 *  - union of baseline ∪ candidate anchorIds (plan §21 — an anchor may
 *    never "disappear" from the candidate to dodge measurement);
 *  - insufficient data classifies as `insufficient-n`, never as a verdict
 *    (unknown ≠ pass, ADR-0023).
 */

import type { AnchorRunRecord } from './types.ts';
import { cohensD, twoProportionTest, wilsonInterval, Z95, type MeanCi } from './stats.ts';

/** Significance level for the suite-level two-proportion test (fixed, documented). */
const ALPHA = 0.05;

export interface MeasuredSide {
  runs: number;
  passes: number;
  passRate: number;
  /** Wilson 95% CI over the pass rate; null only when runs === 0. */
  ci: { lo: number; hi: number } | null;
}

export type AnchorMeasuredClass =
  | 'insufficient-n'
  | 'both-pass'
  | 'both-fail'
  | 'no-change'
  | 'regression-measured'
  | 'regression-possible'
  | 'improvement-measured'
  | 'improvement-possible'
  | 'missing-candidate'
  | 'new-anchor';

export interface AnchorMeasured {
  anchorId: string;
  baseline: MeasuredSide | null;
  candidate: MeasuredSide | null;
  classification: AnchorMeasuredClass;
}

export type SuiteVerdict =
  | 'measured-better'
  | 'measured-worse'
  | 'no-significant-difference'
  | 'insufficient-n';

export interface MeasuredComparison {
  anchors: AnchorMeasured[];
  suite: {
    baseline: MeasuredSide | null;
    candidate: MeasuredSide | null;
    /** Two-proportion z-test on verified rates; null → no test possible (constant outcomes). */
    proportion: { z: number; pValue: number } | null;
    /** Cohen's d over per-run unified cost; null when either side has < 2 records. */
    costPerRunD: number | null;
    baselineCostMean: number | null;
    candidateCostMean: number | null;
    verdict: SuiteVerdict;
  };
  params: { minRunsPerAnchor: number; z: number; alpha: number };
}

function sideOf(records: readonly AnchorRunRecord[]): MeasuredSide | null {
  if (records.length === 0) return null;
  const passes = records.filter((r) => r.verified).length;
  return {
    runs: records.length,
    passes,
    passRate: passes / records.length,
    ci: wilsonInterval(passes, records.length),
  };
}

function classify(
  b: MeasuredSide | null,
  c: MeasuredSide | null,
  minRuns: number,
): AnchorMeasuredClass {
  if (!c) return 'missing-candidate';
  if (!b) return 'new-anchor';
  if (b.runs < minRuns || c.runs < minRuns) return 'insufficient-n';
  if (b.passRate === 1 && c.passRate === 1) return 'both-pass';
  if (b.passRate === 0 && c.passRate === 0) return 'both-fail';
  // CI-vs-CI (conservative non-overlap rule; both non-null because runs ≥ 1).
  if (c.ci!.lo > b.ci!.hi) return 'improvement-measured';
  if (c.ci!.hi < b.ci!.lo) return 'regression-measured';
  if (c.passRate < b.passRate) return 'regression-possible';
  if (c.passRate > b.passRate) return 'improvement-possible';
  return 'no-change';
}

/** Unified per-run cost (plan §23): model + tool spend, same as summarizeCost. */
function unifiedCost(r: AnchorRunRecord): number {
  return r.cost.modelCostUsd + (r.cost.toolCostUsd ?? 0);
}

export function evaluateMeasuredGate(input: {
  baseline: readonly AnchorRunRecord[];
  candidate: readonly AnchorRunRecord[];
  /** Minimum runs per side per anchor before any anchor verdict is emitted. */
  minRunsPerAnchor?: number;
  z?: number;
}): MeasuredComparison {
  const minRuns = Math.max(1, input.minRunsPerAnchor ?? 3);
  const z = input.z ?? Z95;

  const byAnchor = (records: readonly AnchorRunRecord[]) => {
    const map = new Map<string, AnchorRunRecord[]>();
    for (const r of records) {
      const list = map.get(r.anchorId);
      if (list) list.push(r);
      else map.set(r.anchorId, [r]);
    }
    return map;
  };
  const baselineMap = byAnchor(input.baseline);
  const candidateMap = byAnchor(input.candidate);

  const unionIds = [...new Set([...baselineMap.keys(), ...candidateMap.keys()])].sort();
  const anchors: AnchorMeasured[] = unionIds.map((anchorId) => {
    const b = sideOf(baselineMap.get(anchorId) ?? []);
    const c = sideOf(candidateMap.get(anchorId) ?? []);
    return { anchorId, baseline: b, candidate: c, classification: classify(b, c, minRuns) };
  });

  const baseline = sideOf(input.baseline);
  const candidate = sideOf(input.candidate);
  const proportion =
    baseline && candidate
      ? twoProportionTest(baseline.passes, baseline.runs, candidate.passes, candidate.runs)
      : null;

  // Cost effect size needs spread on both sides (≥ 2 records each).
  const bCosts = input.baseline.map(unifiedCost);
  const cCosts = input.candidate.map(unifiedCost);
  const costReady = bCosts.length >= 2 && cCosts.length >= 2;
  const summarizeMean = (xs: readonly number[]): number | null =>
    xs.length > 0 ? xs.reduce((a, b2) => a + b2, 0) / xs.length : null;

  let verdict: SuiteVerdict;
  if (!baseline || !candidate || baseline.runs < minRuns || candidate.runs < minRuns) {
    verdict = 'insufficient-n';
  } else if (proportion === null) {
    // Constant pooled outcome → rates are necessarily equal (see stats.ts doc).
    verdict = 'no-significant-difference';
  } else if (proportion.pValue < ALPHA) {
    verdict = candidate.passRate > baseline.passRate ? 'measured-better' : 'measured-worse';
  } else {
    verdict = 'no-significant-difference';
  }

  return {
    anchors,
    suite: {
      baseline,
      candidate,
      proportion,
      costPerRunD: costReady ? cohensD(bCosts, cCosts) : null,
      baselineCostMean: summarizeMean(bCosts),
      candidateCostMean: summarizeMean(cCosts),
      verdict,
    },
    params: { minRunsPerAnchor: minRuns, z, alpha: ALPHA },
  };
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function sideLine(label: string, s: MeasuredSide | null): string {
  if (!s) return `${label}: no run records`;
  const ci = s.ci ? ` Wilson 95% [${pct(s.ci.lo)}..${pct(s.ci.hi)}]` : '';
  return `${label}: ${s.passes}/${s.runs} verified (${pct(s.passRate)})${ci}`;
}

function listIds(m: MeasuredComparison, cls: AnchorMeasuredClass): string {
  const ids = m.anchors.filter((a) => a.classification === cls).map((a) => a.anchorId);
  return ids.length > 0 ? ids.join(', ') : 'none';
}

export function formatMeasuredReport(
  m: MeasuredComparison,
  ctx?: { baselineHash?: string; candidateHash?: string },
): string {
  const prop =
    m.suite.proportion === null
      ? 'no test possible (constant outcomes)'
      : `two-proportion z = ${m.suite.proportion.z.toFixed(3)}, p = ${m.suite.proportion.pValue.toFixed(4)}`;
  const cost =
    m.suite.costPerRunD === null
      ? 'cost/run effect size: n/a (< 2 records on a side)'
      : `cost/run effect size d = ${m.suite.costPerRunD.toFixed(2)} ` +
        `(mean $${(m.suite.baselineCostMean ?? 0).toFixed(3)} → $${(m.suite.candidateCostMean ?? 0).toFixed(3)})`;
  const lines = [
    'Measured comparison (Fase 0) — advisory, never a promotion on its own',
    ctx?.baselineHash ? `baseline  manifest ${ctx.baselineHash.slice(0, 8)}` : null,
    ctx?.candidateHash ? `candidate manifest ${ctx.candidateHash.slice(0, 8)}` : null,
    '',
    sideLine('Baseline ', m.suite.baseline),
    sideLine('Candidate', m.suite.candidate),
    prop,
    cost,
    '',
    `Anchors (min ${m.params.minRunsPerAnchor} runs/side for a verdict):`,
    `  regression-measured:              ${listIds(m, 'regression-measured')}`,
    `  regression-possible (noise band): ${listIds(m, 'regression-possible')}`,
    `  improvement-measured:             ${listIds(m, 'improvement-measured')}`,
    `  improvement-possible (noise band): ${listIds(m, 'improvement-possible')}`,
    `  insufficient-n:                   ${listIds(m, 'insufficient-n')}`,
    `  missing-candidate:                ${listIds(m, 'missing-candidate')}`,
    `  new-anchor:                       ${listIds(m, 'new-anchor')}`,
    '',
    'VERDICT:',
    m.suite.verdict,
    '',
    'note: higher solve rate alone never implies promotion — the retention gate (runGate.ts) decides',
  ];
  return lines.filter((l): l is string => l !== null).join('\n');
}

/** Re-exported for callers that want t-based CIs on continuous metrics too. */
export type { MeanCi };
