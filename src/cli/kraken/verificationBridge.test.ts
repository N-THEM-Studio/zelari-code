/**
 * verificationBridge tests (ADR-0023 host integration).
 *
 * Covers: check→contract mapping with tolerant matching, the pass-without-
 * evidence rule, ZELARI_STRICT_DONE composition (blockers add, never
 * subtract), and the machine-readable payload shape.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  evaluateStrictBuildGate,
  krakenResultsToContract,
  strictDoneEnabled,
  strictGateEventPayload,
} from './verificationBridge.js';
import {
  resetKrakenCandidates,
  setKrakenCheckResults,
  setKrakenSelection,
} from './candidateRegistry.js';
import type { KrakenCheckResult } from './verifyReport.js';

const CHECKS = ['session survives concurrent refresh', 'rotated cookie rejects the old token'];

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

let envPrev: string | undefined;

beforeEach(() => {
  envPrev = process.env.ZELARI_STRICT_DONE;
  resetKrakenCandidates();
});

afterEach(() => {
  if (envPrev === undefined) delete process.env.ZELARI_STRICT_DONE;
  else process.env.ZELARI_STRICT_DONE = envPrev;
  resetKrakenCandidates();
});

describe('krakenResultsToContract', () => {
  it('maps every required check to a required criterion with a stable id', () => {
    const contract = krakenResultsToContract(CHECKS, [], 1000);
    expect(contract.criteria).toHaveLength(2);
    expect(contract.criteria.every((c) => c.required && c.source === 'kraken-selection')).toBe(true);
    expect(contract.results.every((r) => r.status === 'unknown' && r.source === 'verify-agent')).toBe(true);
  });

  it('a pass WITH a note carries evidence; a pass WITHOUT a note does not', () => {
    const results: KrakenCheckResult[] = [
      { check: CHECKS[0], status: 'pass', note: 'vitest 41/41' },
      { check: CHECKS[1], status: 'pass' },
    ];
    const contract = krakenResultsToContract(CHECKS, results, 2000);
    expect(contract.results[0].evidence).toHaveLength(1);
    expect(contract.results[0].evidence[0].tier).toBe('tool-output');
    expect(contract.results[1].evidence).toHaveLength(0);
  });

  it('tolerates lightly reworded check text (containment matching)', () => {
    const results: KrakenCheckResult[] = [
      { check: 'Session survives concurrent REFRESH (reworded)', status: 'pass', note: 'x' },
    ];
    const contract = krakenResultsToContract([CHECKS[0]], results);
    expect(contract.results[0].status).toBe('pass');
    expect(contract.results[0].evidence).toHaveLength(1);
  });
});

describe('evaluateStrictBuildGate', () => {
  it('strict off (default): mirrors the legacy gate exactly', () => {
    delete process.env.ZELARI_STRICT_DONE;
    expect(strictDoneEnabled()).toBe(false);
    selectWithChecks(CHECKS);
    setKrakenCheckResults([
      { check: CHECKS[0], status: 'pass', note: 'ok' },
      { check: CHECKS[1], status: 'fail', note: 'assert' },
    ]);
    const evaluation = evaluateStrictBuildGate('build');
    expect(evaluation.strict).toBe(false);
    expect(evaluation.evaluation).toBeNull();
    expect(evaluation.blocked).toBe(true);
  });

  it('strict on + all pass with notes → PASS', () => {
    process.env.ZELARI_STRICT_DONE = '1';
    selectWithChecks(CHECKS);
    setKrakenCheckResults([
      { check: CHECKS[0], status: 'pass', note: 'vitest 41/41' },
      { check: CHECKS[1], status: 'pass', note: 'curl 401' },
    ]);
    const evaluation = evaluateStrictBuildGate('build');
    expect(evaluation.strict).toBe(true);
    expect(evaluation.evaluation!.verdict).toBe('PASS');
    expect(evaluation.blocked).toBe(false);
  });

  it('strict on + pass WITHOUT evidence → BLOCKED (false-done guard)', () => {
    process.env.ZELARI_STRICT_DONE = '1';
    selectWithChecks(CHECKS);
    setKrakenCheckResults([
      { check: CHECKS[0], status: 'pass', note: 'vitest 41/41' },
      { check: CHECKS[1], status: 'pass' }, // no note → no evidence
    ]);
    const evaluation = evaluateStrictBuildGate('build');
    expect(evaluation.evaluation!.verdict).toBe('BLOCKED');
    expect(evaluation.blocked).toBe(true);
    expect(evaluation.evaluation!.unsatisfied[0].status).toBe('unknown');
    expect(evaluation.evaluation!.unsatisfied[0].reason).toContain('without evidence');
  });

  it('strict on + legacy fail → REPAIR_REQUIRED (fail wins over unknown)', () => {
    process.env.ZELARI_STRICT_DONE = '1';
    selectWithChecks(CHECKS);
    setKrakenCheckResults([
      { check: CHECKS[0], status: 'fail', note: 'assert false' },
      { check: CHECKS[1], status: 'unknown' },
    ]);
    const evaluation = evaluateStrictBuildGate('build');
    expect(evaluation.evaluation!.verdict).toBe('REPAIR_REQUIRED');
    expect(evaluation.blocked).toBe(true);
  });

  it('PLAN turns and turns without selection stay open', () => {
    process.env.ZELARI_STRICT_DONE = '1';
    expect(evaluateStrictBuildGate('plan').blocked).toBe(false);
    resetKrakenCandidates();
    expect(evaluateStrictBuildGate('build').blocked).toBe(false);
  });
});

describe('strictGateEventPayload', () => {
  it('is JSON-serializable and carries both gate layers', () => {
    process.env.ZELARI_STRICT_DONE = '1';
    selectWithChecks(CHECKS);
    setKrakenCheckResults([{ check: CHECKS[0], status: 'pass', note: 'n' }]);
    const payload = strictGateEventPayload(evaluateStrictBuildGate('build'));
    expect(() => JSON.stringify(payload)).not.toThrow();
    expect(payload).toMatchObject({ strict: true, engine: 'kraken-legacy+completion-policy' });
    expect(payload.legacy).toMatchObject({ total: 2 });
    expect(payload.evidence).not.toBeNull();
  });
});
