/**
 * tools/eval/regressionGate.ts — baseline vs candidate harness comparison
 * (2.6 Track A, doc §8). Commit rule (§8.5):
 *
 *   validity PASS  AND  regressions <= retention budget
 *   AND improvement >= threshold (if configured)
 *   AND cost efficiency within policy (if configured)
 */

import { addCost, zeroCost, type RunCost } from './cost.ts';
import type { AnchorRunRecord } from './types.ts';
import type { HarnessRetentionPolicy } from './retentionPolicy.ts';

export interface AnchorRegression {
  anchorId: string;
  baseline: 'pass' | 'fail' | 'blocked';
  candidate: 'pass' | 'fail' | 'blocked';
}

export interface AnchorImprovement {
  anchorId: string;
  baseline: 'pass' | 'fail' | 'blocked';
  candidate: 'pass' | 'fail' | 'blocked';
}

export interface RunCostSummary {
  total: RunCost;
  verifiedSolves: number;
  costPerVerifiedSolve: number | null;
  wallMsPerVerifiedSolve: number | null;
  toolCallsPerVerifiedSolve: number | null;
}

export interface HarnessEvalResult {
  manifestHash: string;
  currentSuite: { passed: number; total: number };
  anchors: {
    passed: number;
    total: number;
    regressions: AnchorRegression[];
    improvements: AnchorImprovement[];
  };
  validity: { passed: boolean; violations: string[] };
  cost: RunCostSummary;
}

export interface GateComparison {
  result: HarnessEvalResult;
  decision: 'COMMIT' | 'REJECT';
  reasons: string[];
  policy: HarnessRetentionPolicy;
}

export function summarizeCost(records: readonly AnchorRunRecord[]): RunCostSummary {
  const total = records.reduce<RunCost>((acc, r) => addCost(acc, r.cost), zeroCost());
  const solves = records.filter((r) => r.verified).length;
  return {
    total,
    verifiedSolves: solves,
    costPerVerifiedSolve: solves > 0 ? total.modelCostUsd / solves : null,
    wallMsPerVerifiedSolve: solves > 0 ? total.wallMs / solves : null,
    toolCallsPerVerifiedSolve: solves > 0 ? total.toolCalls / solves : null,
  };
}

/**
 * Compare a candidate run set against the recorded baseline under a policy.
 * `currentSuite` is the NEW capability suite (passed/total, from the same
 * record format); validity violations are collected by the caller (session
 * invariants, evidence policy) and ALWAYS reject (§26.7).
 */
export function evaluateRegressionGate(input: {
  manifestHash: string;
  baseline: readonly AnchorRunRecord[];
  candidate: readonly AnchorRunRecord[];
  currentSuite: { passed: number; total: number };
  baselineCurrentSuite?: { passed: number; total: number };
  validityViolations?: readonly string[];
  policy: HarnessRetentionPolicy;
}): GateComparison {
  const { manifestHash, baseline, candidate, currentSuite, policy } = input;
  const reasons: string[] = [];

  const baselineById = new Map(baseline.map((r) => [r.anchorId, r]));
  const regressions: AnchorRegression[] = [];
  const improvements: AnchorImprovement[] = [];
  let passed = 0;
  for (const c of candidate) {
    if (c.result === 'pass') passed += 1;
    const b = baselineById.get(c.anchorId);
    if (!b) continue;
    if (b.result === 'pass' && c.result !== 'pass') {
      regressions.push({ anchorId: c.anchorId, baseline: b.result, candidate: c.result });
    } else if (b.result !== 'pass' && c.result === 'pass') {
      improvements.push({ anchorId: c.anchorId, baseline: b.result, candidate: c.result });
    }
  }

  const result: HarnessEvalResult = {
    manifestHash,
    currentSuite,
    anchors: { passed, total: candidate.length, regressions, improvements },
    validity: {
      passed: (input.validityViolations ?? []).length === 0,
      violations: [...(input.validityViolations ?? [])],
    },
    cost: summarizeCost(candidate),
  };

  // Commit rule (§8.5).
  let ok = true;
  if (!result.validity.passed) {
    ok = false;
    reasons.push(`validity FAIL: ${result.validity.violations.join('; ')}`);
  }
  if (regressions.length > policy.maxRegressedAnchors) {
    ok = false;
    reasons.push(
      `regressions ${regressions.length} > retention budget ${policy.maxRegressedAnchors} (${regressions
        .map((r) => r.anchorId)
        .join(', ')})`,
    );
  }
  if (policy.minCurrentImprovement !== undefined && input.baselineCurrentSuite) {
    const delta = currentSuite.passed - input.baselineCurrentSuite.passed;
    if (delta < policy.minCurrentImprovement) {
      ok = false;
      reasons.push(`new-suite improvement ${delta} < required ${policy.minCurrentImprovement}`);
    }
  }
  if (policy.maxCostPerSolveIncreasePct !== undefined) {
    const base = summarizeCost(baseline);
    if (base.costPerVerifiedSolve !== null && result.cost.costPerVerifiedSolve !== null && base.costPerVerifiedSolve > 0) {
      const pct = ((result.cost.costPerVerifiedSolve - base.costPerVerifiedSolve) / base.costPerVerifiedSolve) * 100;
      if (pct > policy.maxCostPerSolveIncreasePct) {
        ok = false;
        reasons.push(`cost/solve +${pct.toFixed(1)}% > ${policy.maxCostPerSolveIncreasePct}%`);
      }
    }
  }

  return { result, decision: ok ? 'COMMIT' : 'REJECT', reasons, policy };
}
