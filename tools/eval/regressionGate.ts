/**
 * tools/eval/regressionGate.ts — baseline vs candidate harness comparison
 * (2.6 Track A, doc §8). Commit rule (§8.5):
 *
 *   validity PASS  AND  regressions <= retention budget
 *   AND improvement >= threshold (if configured)
 *   AND cost efficiency within policy (if configured)
 *   AND verified solve rate >= minVerificationGatePassRate (if configured;
 *   §P1.2 — fail-closed when the candidate has no records)
 *   AND candidate runs per anchor >= minMeasuredRuns (if configured; Fase
 *   0.1 — fail-closed multi-run floor, enforced via validity, §21/ADR-0023)
 */

import { addCost, zeroCost, type RunCost } from './cost.ts';
import type { AnchorRunRecord } from './types.ts';
import type { HarnessRetentionPolicy } from './retentionPolicy.ts';

export interface AnchorRegression {
  anchorId: string;
  baseline: 'pass' | 'fail' | 'blocked';
  /** `missing` = baseline PASS with NO candidate record (2.6.1, plan §21). */
  candidate: 'pass' | 'fail' | 'blocked' | 'missing';
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
  /** Candidate anchor-run count the rate below is measured over (report `N/M`). */
  candidateRecords: number;
  /** verifiedSolves / candidateRecords (§P1.2); null iff zero candidate records. */
  verifiedSolveRate: number | null;
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
  // 2.6.1 (plan §23): unified cost = model + tool spend per verified solve.
  const unifiedUsd = total.modelCostUsd + (total.toolCostUsd ?? 0);
  return {
    total,
    verifiedSolves: solves,
    costPerVerifiedSolve: solves > 0 ? unifiedUsd / solves : null,
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
  const candidateById = new Map(candidate.map((r) => [r.anchorId, r]));
  const regressions: AnchorRegression[] = [];
  const improvements: AnchorImprovement[] = [];
  let passed = 0;
  // 2.6.1 (plan §21): compare over the UNION of baseline ∪ candidate ids —
  // an anchor may never "disappear" from the candidate to dodge the gate.
  // Baseline PASS + no candidate record is itself a REGRESSION.
  const unionIds = [...new Set([...baselineById.keys(), ...candidateById.keys()])].sort();
  // Fase 0.1: opt-in multi-run measurement floor. Counts come from the RAW
  // candidate array (the id Maps dedupe, last-wins) and EVERY union anchor
  // must clear the bar — zero-run ones included (§21: nothing dodges
  // measurement; ADR-0023 unknown ≠ pass). Violations merge into the
  // caller's validity path, so the existing validity logic rejects unchanged.
  const validityViolations = [...(input.validityViolations ?? [])];
  if (policy.minMeasuredRuns !== undefined) {
    const candidateRunsById = new Map<string, number>();
    for (const r of candidate) candidateRunsById.set(r.anchorId, (candidateRunsById.get(r.anchorId) ?? 0) + 1);
    for (const anchorId of unionIds) {
      const runs = candidateRunsById.get(anchorId) ?? 0;
      if (runs < policy.minMeasuredRuns) {
        validityViolations.push(`insufficient-measured-runs:${anchorId}:${runs}/${policy.minMeasuredRuns}`);
      }
    }
  }
  for (const anchorId of unionIds) {
    const b = baselineById.get(anchorId);
    const c = candidateById.get(anchorId);
    if (!c) {
      if (b && b.result === 'pass') {
        regressions.push({ anchorId, baseline: b.result, candidate: 'missing' });
      }
      continue;
    }
    if (c.result === 'pass') passed += 1;
    if (!b) continue;
    if (b.result === 'pass' && c.result !== 'pass') {
      regressions.push({ anchorId, baseline: b.result, candidate: c.result });
    } else if (b.result !== 'pass' && c.result === 'pass') {
      improvements.push({ anchorId, baseline: b.result, candidate: c.result });
    }
  }

  const result: HarnessEvalResult = {
    manifestHash,
    currentSuite,
    anchors: { passed, total: unionIds.length, regressions, improvements },
    validity: {
      passed: validityViolations.length === 0,
      violations: validityViolations,
    },
    cost: summarizeCost(candidate),
    // §P1.2 strict verification gate — measured over the RAW candidate
    // records; the cost summary's verifiedSolves count matches this filter.
    candidateRecords: candidate.length,
    verifiedSolveRate:
      candidate.length > 0 ? candidate.filter((r) => r.verified).length / candidate.length : null,
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

  // Strict verification gate (§P1.2) — FAIL-CLOSED: an empty candidate set
  // measures nothing and must never silently pass.
  if (policy.minVerificationGatePassRate !== undefined) {
    const rate = result.verifiedSolveRate;
    if (rate === null) {
      ok = false;
      reasons.push('verified solve rate n/a (no candidate records)');
    } else if (rate < policy.minVerificationGatePassRate) {
      ok = false;
      reasons.push(
        `verified solve rate ${rate.toFixed(2)} < required ${policy.minVerificationGatePassRate.toFixed(2)} (${result.cost.verifiedSolves}/${result.candidateRecords})`,
      );
    }
  }
  return { result, decision: ok ? 'COMMIT' : 'REJECT', reasons, policy };
}
