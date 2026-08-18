/**
 * Fase 8 (ADR-0020) — completion gate unit tests.
 *
 * classify: pure matching semantics (mirrors verifyReport).
 * evaluate: registry-driven gating (build-only, selection-only).
 * prompt: repair directive shape.
 */
import { describe, expect, it } from 'vitest';
import {
  buildKrakenRepairPrompt,
  classifyKrakenChecks,
  evaluateKrakenCompletionGate,
} from './completionGate.js';
import {
  resetKrakenCandidates,
  setKrakenCheckResults,
  setKrakenSelection,
} from './candidateRegistry.js';
import type { KrakenCheckResult } from './verifyReport.js';

const CHECKS = [
  'session survives concurrent refresh',
  'rotated cookie rejects the old token',
];

function result(check: string, status: KrakenCheckResult['status']): KrakenCheckResult {
  return { check, status };
}

function selectWithChecks(checks: string[]): void {
  resetKrakenCandidates();
  setKrakenSelection({
    status: 'selected',
    winnerIndex: 1,
    rationale: 'stronger evidence',
    requiredChecks: checks,
    degraded: false,
    verifier: null,
    judgedBy: 'llm',
  });
}

describe('classifyKrakenChecks', () => {
  it('null results → every check unknown (no report ≠ pass)', () => {
    const out = classifyKrakenChecks(CHECKS, null);
    expect(out.unknown).toEqual(CHECKS);
    expect(out.passed).toEqual([]);
    expect(out.failed).toEqual([]);
  });

  it('groups pass/fail/unknown by exact normalized match', () => {
    const out = classifyKrakenChecks(CHECKS, [
      result('Session survives concurrent  refresh', 'pass'),
      result('rotated cookie rejects the old token', 'fail'),
    ]);
    expect(out.passed).toEqual([CHECKS[0]]);
    expect(out.failed).toEqual([CHECKS[1]]);
    expect(out.unknown).toEqual([]);
  });

  it('matches a lightly reworded criterion by containment', () => {
    const out = classifyKrakenChecks(
      ['race condition on concurrent session refresh'],
      [result('concurrent session refresh', 'pass')],
    );
    expect(out.passed).toEqual(['race condition on concurrent session refresh']);
  });

  it('later duplicate results win (self-correction)', () => {
    const out = classifyKrakenChecks(CHECKS, [
      result(CHECKS[0], 'fail'),
      result(CHECKS[0], 'pass'),
    ]);
    expect(out.passed).toEqual([CHECKS[0]]);
    expect(out.failed).toEqual([]);
  });

  it('a check with no matching block is unknown, never pass', () => {
    const out = classifyKrakenChecks(CHECKS, [result('totally unrelated check', 'pass')]);
    expect(out.unknown).toEqual(CHECKS);
  });
});

describe('evaluateKrakenCompletionGate', () => {
  it('open when no selection ran this turn', () => {
    resetKrakenCandidates();
    const gate = evaluateKrakenCompletionGate('build');
    expect(gate.blocked).toBe(false);
    expect(gate.selectionUsed).toBe(false);
  });

  it('open for needs_more_evidence — checks stay advisory', () => {
    resetKrakenCandidates();
    setKrakenSelection({
      status: 'needs_more_evidence',
      winnerIndex: null,
      rationale: 'tie',
      requiredChecks: ['advisory check'],
      degraded: false,
      verifier: null,
      judgedBy: 'llm',
    });
    expect(evaluateKrakenCompletionGate('build').blocked).toBe(false);
  });

  it('blocked when verification never ran (all unknown)', () => {
    selectWithChecks(CHECKS);
    const gate = evaluateKrakenCompletionGate('build');
    expect(gate.blocked).toBe(true);
    expect(gate.selectionUsed).toBe(true);
    expect(gate.total).toBe(2);
    expect(gate.passed).toBe(0);
    expect(gate.unknownChecks).toEqual(CHECKS);
  });

  it('blocked while any check fails (pass does not offset fail)', () => {
    selectWithChecks(CHECKS);
    setKrakenCheckResults([
      result(CHECKS[0], 'pass'),
      result(CHECKS[1], 'fail'),
    ]);
    const gate = evaluateKrakenCompletionGate('build');
    expect(gate.blocked).toBe(true);
    expect(gate.failedChecks).toEqual([CHECKS[1]]);
  });

  it('blocked while any check is unknown (unknown ≠ pass)', () => {
    selectWithChecks(CHECKS);
    setKrakenCheckResults([
      result(CHECKS[0], 'pass'),
      result(CHECKS[1], 'unknown'),
    ]);
    expect(evaluateKrakenCompletionGate('build').blocked).toBe(true);
  });

  it('open only when every check passes', () => {
    selectWithChecks(CHECKS);
    setKrakenCheckResults(CHECKS.map((c) => result(c, 'pass')));
    const gate = evaluateKrakenCompletionGate('build');
    expect(gate.blocked).toBe(false);
    expect(gate.passed).toBe(2);
  });

  it('never blocks a PLAN turn even with unresolved checks', () => {
    selectWithChecks(CHECKS);
    // no results at all → would block in build
    expect(evaluateKrakenCompletionGate('build').blocked).toBe(true);
    expect(evaluateKrakenCompletionGate('plan').blocked).toBe(false);
  });

  it('reset clears the gate state', () => {
    selectWithChecks(CHECKS);
    resetKrakenCandidates();
    expect(evaluateKrakenCompletionGate('build').selectionUsed).toBe(false);
  });
});

describe('buildKrakenRepairPrompt', () => {
  it('lists failed and unknown checks with the pass counter', () => {
    const prompt = buildKrakenRepairPrompt({
      blocked: true,
      selectionUsed: true,
      total: 3,
      passed: 1,
      failedChecks: ['race on refresh'],
      unknownChecks: ['cookie rotation'],
    });
    expect(prompt).toContain('passed 1/3');
    expect(prompt).toContain('FAILED checks');
    expect(prompt).toContain('- race on refresh');
    expect(prompt).toContain('UNKNOWN checks');
    expect(prompt).toContain('- cookie rotation');
  });

  it('forbids re-running kraken_select and demands a verify tentacle', () => {
    const prompt = buildKrakenRepairPrompt({
      blocked: true,
      selectionUsed: true,
      total: 1,
      passed: 0,
      failedChecks: ['x'],
      unknownChecks: [],
    });
    expect(prompt).toContain('do NOT call kraken_select again');
    expect(prompt).toContain('`task verify`');
    expect(prompt).toContain('<verify-report>');
    expect(prompt).toContain('status: pass');
  });

  it('omits empty sections', () => {
    const prompt = buildKrakenRepairPrompt({
      blocked: true,
      selectionUsed: true,
      total: 2,
      passed: 0,
      failedChecks: [],
      unknownChecks: ['a', 'b'],
    });
    expect(prompt).not.toContain('FAILED checks');
    expect(prompt).toContain('UNKNOWN checks');
  });
});
