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
  strictGateExitCode,
} from './verificationBridge.js';
import {
  resetKrakenCandidates,
  setKrakenCheckResults,
  setKrakenSelection,
} from './candidateRegistry.js';
import type { KrakenCheckResult } from './verifyReport.js';

const CHECKS = ['session survives concurrent refresh', 'rotated cookie rejects the old token'];

/** Fake spine emitter that stamps sequential seq so notes become event-backed. */
function emitSeq(): (input: unknown) => Promise<{ seq: number }> {
  let n = 1;
  return async () => ({ seq: n++ });
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

let envPrev: string | undefined;

beforeEach(() => {
  envPrev = process.env.ZELARI_STRICT_DONE;
  process.env.ZELARI_VERIFY_PACK = '0'; // P0.2 default ON — keep gate tests hermetic
  resetKrakenCandidates();
});

afterEach(() => {
  if (envPrev === undefined) delete process.env.ZELARI_STRICT_DONE;
  else process.env.ZELARI_STRICT_DONE = envPrev;
  delete process.env.ZELARI_VERIFY_PACK;
  resetKrakenCandidates();
});

describe('krakenResultsToContract', () => {
  it('maps every required check to a required criterion with a stable id', async () => {
    const contract = krakenResultsToContract(CHECKS, [], 1000);
    expect(contract.criteria).toHaveLength(2);
    expect(contract.criteria.every((c) => c.required && c.source === 'kraken-selection')).toBe(true);
    expect(contract.results.every((r) => r.status === 'unknown' && r.source === 'verify-agent')).toBe(true);
  });

  it('M1.4: a note is a PROPOSAL — verifier narration tier, not tool-output; no note → no evidence', async () => {
    const results: KrakenCheckResult[] = [
      { check: CHECKS[0], status: 'pass', note: 'vitest 41/41' },
      { check: CHECKS[1], status: 'pass' },
    ];
    const contract = krakenResultsToContract(CHECKS, results, 2000);
    expect(contract.results[0].evidence).toHaveLength(1);
    expect(contract.results[0].evidence[0].tier).toBe('verifier-llm');
    expect(contract.results[1].evidence).toHaveLength(0);
  });

  it('M1.5: lightly reworded check text no longer fuzzy-matches → unknown, never a false pass', async () => {
    const results: KrakenCheckResult[] = [
      { check: 'Session survives concurrent REFRESH (reworded)', status: 'pass', note: 'x' },
    ];
    const contract = krakenResultsToContract([CHECKS[0]], results);
    expect(contract.results[0].status).toBe('unknown');
    expect(contract.results[0].evidence).toHaveLength(0);
  });
});

describe('evaluateStrictBuildGate', () => {
  it('strict off (opt-out): mirrors the legacy gate exactly', async () => {
    process.env.ZELARI_STRICT_DONE = '0';
    expect(strictDoneEnabled()).toBe(false);
    selectWithChecks(CHECKS);
    setKrakenCheckResults([
      { check: CHECKS[0], status: 'pass', note: 'ok' },
      { check: CHECKS[1], status: 'fail', note: 'assert' },
    ]);
    const evaluation = await evaluateStrictBuildGate('build');
    expect(evaluation.strict).toBe(false);
    expect(evaluation.evaluation).toBeNull();
    expect(evaluation.blocked).toBe(true);
  });

  it('M1.3: strict on + all pass with notes → BLOCKED (pattern B dead — a re-emitted note is not evidence)', async () => {
    process.env.ZELARI_STRICT_DONE = '1';
    selectWithChecks(CHECKS);
    setKrakenCheckResults([
      { check: CHECKS[0], status: 'pass', note: 'vitest 41/41' },
      { check: CHECKS[1], status: 'pass', note: 'curl 401' },
    ]);
    const evaluation = await evaluateStrictBuildGate('build', { emit: emitSeq() });
    expect(evaluation.strict).toBe(true);
    expect(evaluation.evaluation!.verdict).toBe('BLOCKED');
    expect(evaluation.blocked).toBe(true);
    expect(evaluation.anchoring?.noteFallback).toBe(2);
  });

  it('strict on + notes without spine emit → BLOCKED (inadmissible narration tier)', async () => {
    process.env.ZELARI_STRICT_DONE = '1';
    selectWithChecks(CHECKS);
    setKrakenCheckResults([
      { check: CHECKS[0], status: 'pass', note: 'vitest 41/41' },
      { check: CHECKS[1], status: 'pass', note: 'curl 401' },
    ]);
    const evaluation = await evaluateStrictBuildGate('build'); // no emit → unanchored
    expect(evaluation.evaluation!.verdict).toBe('BLOCKED');
    expect(evaluation.evaluation!.unsatisfied[0].reason).toContain('inadmissible');
  });

  it('strict on + note-only evidence → BLOCKED (false-done guard)', async () => {
    process.env.ZELARI_STRICT_DONE = '1';
    selectWithChecks(CHECKS);
    setKrakenCheckResults([
      { check: CHECKS[0], status: 'pass', note: 'vitest 41/41' },
      { check: CHECKS[1], status: 'pass' }, // no note → no evidence
    ]);
    const evaluation = await evaluateStrictBuildGate('build', { emit: emitSeq() });
    expect(evaluation.evaluation!.verdict).toBe('BLOCKED');
    expect(evaluation.blocked).toBe(true);
    expect(evaluation.evaluation!.unsatisfied[0].status).toBe('unknown');
    expect(evaluation.evaluation!.unsatisfied[0].reason).toContain('inadmissible evidence tiers');
  });

  it('strict on + legacy fail → REPAIR_REQUIRED (fail wins over unknown)', async () => {
    process.env.ZELARI_STRICT_DONE = '1';
    selectWithChecks(CHECKS);
    setKrakenCheckResults([
      { check: CHECKS[0], status: 'fail', note: 'assert false' },
      { check: CHECKS[1], status: 'unknown' },
    ]);
    const evaluation = await evaluateStrictBuildGate('build', { emit: emitSeq() });
    expect(evaluation.evaluation!.verdict).toBe('REPAIR_REQUIRED');
    expect(evaluation.blocked).toBe(true);
  });

  it('M1.2: PLAN turns and turns without selection are UNVERIFIED, not open', async () => {
    process.env.ZELARI_STRICT_DONE = '1';
    const plan = await evaluateStrictBuildGate('plan');
    expect(plan.blocked).toBe(true);
    expect(plan.unverified).toBe(true);
    resetKrakenCandidates();
    const bare = await evaluateStrictBuildGate('build');
    expect(bare.blocked).toBe(true);
    expect(bare.unverified).toBe(true);
    expect(strictGateExitCode(bare)).toBe(4);
    expect(strictGateExitCode(bare, { ZELARI_ALLOW_UNVERIFIED: '1' })).toBe(0);
  });
});

describe('strictGateEventPayload', () => {
  it('is JSON-serializable and carries both gate layers', async () => {
    process.env.ZELARI_STRICT_DONE = '1';
    selectWithChecks(CHECKS);
    setKrakenCheckResults([{ check: CHECKS[0], status: 'pass', note: 'n' }]);
    const payload = strictGateEventPayload(await evaluateStrictBuildGate('build', { emit: emitSeq() }));
    expect(() => JSON.stringify(payload)).not.toThrow();
    expect(payload).toMatchObject({ strict: true, engine: 'kraken-legacy+completion-policy' });
    expect(payload.legacy).toMatchObject({ total: 2 });
    expect(payload.evidence).not.toBeNull();
  });
});

describe('strictGateExitCode (E2.2 — blocked strict done closes non-success)', () => {
  it('strict on + blocked after repair → dedicated exit code 4', async () => {
    process.env.ZELARI_STRICT_DONE = '1';
    selectWithChecks(CHECKS);
    setKrakenCheckResults([
      { check: CHECKS[0], status: 'pass', note: 'vitest 41/41' },
      { check: CHECKS[1], status: 'unknown' },
    ]);
    const evaluation = await evaluateStrictBuildGate('build', { emit: emitSeq() });
    expect(evaluation.blocked).toBe(true);
    expect(strictGateExitCode(evaluation)).toBe(4);
  });

  it('M1.3: strict on + note-only "complete" evidence → blocked, exit 4 (pattern B cannot rescue)', async () => {
    process.env.ZELARI_STRICT_DONE = '1';
    selectWithChecks([CHECKS[0]]);
    setKrakenCheckResults([{ check: CHECKS[0], status: 'pass', note: 'vitest 41/41' }]);
    const evaluation = await evaluateStrictBuildGate('build', { emit: emitSeq() });
    expect(evaluation.blocked).toBe(true);
    expect(strictGateExitCode(evaluation)).toBe(4);
    // The allow-unverified hatch does NOT waive a real evidence failure.
    expect(strictGateExitCode(evaluation, { ZELARI_ALLOW_UNVERIFIED: '1' })).toBe(4);
  });

  it('strict off + legacy blocked → 0 (enforcement is strict-only)', async () => {
    process.env.ZELARI_STRICT_DONE = '0';
    selectWithChecks(CHECKS);
    setKrakenCheckResults([{ check: CHECKS[0], status: 'fail', note: 'red' }]);
    const evaluation = await evaluateStrictBuildGate('build');
    expect(evaluation.blocked).toBe(true);
    expect(evaluation.strict).toBe(false);
    expect(strictGateExitCode(evaluation)).toBe(0);
  });
});
