import { describe, expect, it } from 'vitest';
import { evaluateCompletion, strictBuildGate, STRICT_ALL_POLICY, STRICT_BUILD_POLICY } from './completionPolicy.js';
import { codingCriteriaPack, ZELARI_CODING_PACK_ID } from './criteriaPack.v1.js';
import { computeFalseDoneRate, verifiedSolveRate, verificationCostRatio } from './metrics.js';
import type { Criterion, VerificationResult } from './types.js';

function result(criterionId: string, status: VerificationResult['status'], evidenceCount = 1): VerificationResult {
  return {
    criterionId,
    status,
    source: 'deterministic-engine',
    evidence: Array.from({ length: evidenceCount }, () => ({ tier: 'command-output' as const, ref: 'cmd', capturedAt: 0, seq: 1 })),
    evaluatedAt: 0,
    durationMs: 5,
  };
}

const crit = (id: string, required = true): Criterion => ({ id, text: id, source: 'task', required });

describe('evaluateCompletion (strict gate)', () => {
  it('PASS only when every required criterion passes WITH evidence', () => {
    const criteria = [crit('a'), crit('b'), crit('c', false)];
    const results = [result('a', 'pass'), result('b', 'pass'), result('c', 'unknown')];
    const evaluation = evaluateCompletion(criteria, results);
    expect(evaluation.verdict).toBe('PASS');
    expect(evaluation.satisfied).toEqual(['a', 'b']);
    expect(evaluation.evidenceComplete).toBe(true);
  });

  it('unknown ≠ pass: unknown required criterion blocks (BLOCKED)', () => {
    const evaluation = evaluateCompletion([crit('a'), crit('b')], [result('a', 'pass'), result('b', 'unknown')]);
    expect(evaluation.verdict).toBe('BLOCKED');
    expect(evaluation.unsatisfied[0]).toMatchObject({ id: 'b', status: 'unknown' });
  });

  it('missing result for a required criterion blocks a clean done', () => {
    const evaluation = evaluateCompletion([crit('a'), crit('b')], [result('a', 'pass')]);
    expect(evaluation.verdict).toBe('BLOCKED');
    expect(evaluation.unsatisfied).toEqual([{ id: 'b', status: 'missing', reason: 'no verification result' }]);
  });

  it('fail → REPAIR_REQUIRED (repair loop), even alongside unknowns', () => {
    const evaluation = evaluateCompletion([crit('a'), crit('b')], [result('a', 'fail'), result('b', 'unknown')]);
    expect(evaluation.verdict).toBe('REPAIR_REQUIRED');
  });

  it('pass WITHOUT evidence refs is downgraded — not acceptable for completion', () => {
    const evaluation = evaluateCompletion([crit('a')], [result('a', 'pass', 0)]);
    expect(evaluation.verdict).toBe('BLOCKED');
    expect(evaluation.unsatisfied[0]?.reason).toContain('without evidence');
  });

  it('optional criteria never gate; explicit required list is honored', () => {
    const evaluation = evaluateCompletion(
      [crit('a'), crit('opt', false)],
      [result('a', 'pass'), result('opt', 'unknown')],
      { mode: 'strict', required: '*' },
    );
    expect(evaluation.verdict).toBe('PASS');
    const narrowed = evaluateCompletion([crit('a'), crit('b')], [result('b', 'pass')], {
      mode: 'strict',
      required: ['b'],
    });
    expect(narrowed.verdict).toBe('PASS');
  });

  it('strictBuildGate is the strict BUILD/mission gate alias', () => {
    expect(strictBuildGate([crit('a')], [result('a', 'unknown')], STRICT_ALL_POLICY).verdict).toBe('BLOCKED');
  });
});

describe('codingCriteriaPack v1', () => {
  it('binds the three required correctness criteria to repo commands', () => {
    const pack = codingCriteriaPack();
    expect(pack.id).toBe(ZELARI_CODING_PACK_ID);
    const required = pack.criteria.filter((c) => c.required).map((c) => c.id).sort();
    expect(required).toEqual([
      'correctness.error-signals',
      'correctness.observable-output',
      'correctness.specification',
    ]);
    for (const c of pack.criteria.filter((x) => x.required)) {
      expect(c.check?.kind).toBe('command');
    }
  });

  it('null commands leave criteria honestly unknown (advisory)', () => {
    const pack = codingCriteriaPack({ typecheckCommand: null, testCommand: null, buildCommand: null });
    const results = [{ criterionId: 'x', status: 'pass' }].map((r) => result(r.criterionId, 'pass' as const, 0));
    // With no checks bound the required criteria have no results at all:
    const evaluation = evaluateCompletion(pack.criteria, results);
    expect(evaluation.verdict).toBe('BLOCKED');
  });
});

describe('metrics', () => {
  const samples = [
    { taskId: '1', claimedDone: true, verified: true },
    { taskId: '2', claimedDone: true, verified: false },
    { taskId: '3', claimedDone: true }, // never verified
    { taskId: '4', claimedDone: false },
  ];

  it('false-done rate counts claimed-but-unverified over claimed', () => {
    expect(computeFalseDoneRate(samples)).toEqual({ claimed: 3, falseDone: 2, rate: 2 / 3 });
    expect(computeFalseDoneRate([]).rate).toBe(0);
  });

  it('verified solve rate and cost ratio', () => {
    expect(verifiedSolveRate(samples)).toBe(0.25);
    expect(verificationCostRatio(250, 1000)).toBe(0.25);
    expect(verificationCostRatio(100, 0)).toBeNull();
  });
});

describe('admissible evidence tiers (E2.2 — an LLM score alone is not done)', () => {
  const llmOnly = (id: string): VerificationResult => ({
    ...result(id, 'pass'),
    evidence: [{ tier: 'verifier-llm', ref: 'llm-score', capturedAt: 0 }],
  });

  it('STRICT_BUILD_POLICY: verifier-llm-only evidence blocks completion', () => {
    const evaluation = evaluateCompletion([crit('a')], [llmOnly('a')], STRICT_BUILD_POLICY);
    expect(evaluation.verdict).toBe('BLOCKED');
    expect(evaluation.unsatisfied[0]).toMatchObject({ id: 'a', status: 'unknown' });
    expect(evaluation.unsatisfied[0].reason).toContain('verifier-llm');
    expect(evaluation.evidenceComplete).toBe(false);
  });

  it('STRICT_BUILD_POLICY: deterministic evidence passes', () => {
    const evaluation = evaluateCompletion([crit('a')], [result('a', 'pass')], STRICT_BUILD_POLICY);
    expect(evaluation.verdict).toBe('PASS');
  });

  it('mixed evidence passes when at least one tier is deterministic', () => {
    const mixed: VerificationResult = {
      ...result('a', 'pass'),
      evidence: [
        { tier: 'verifier-llm', ref: 'llm-score', capturedAt: 0 },
        { tier: 'command-output', ref: 'npm test', capturedAt: 0, seq: 1 },
      ],
    };
    expect(evaluateCompletion([crit('a')], [mixed], STRICT_BUILD_POLICY).verdict).toBe('PASS');
  });

  it('default policy keeps every tier admissible (legacy behaviour)', () => {
    expect(evaluateCompletion([crit('a')], [llmOnly('a')]).verdict).toBe('PASS');
  });
});
