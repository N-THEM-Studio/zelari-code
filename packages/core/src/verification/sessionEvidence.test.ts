/**
 * sessionEvidence tests — Exit-2/E2.1.
 *
 * The strict completion verdict must be reconstructible from the session log
 * alone, with the P1 discipline: unknown ≠ pass, non-strict records never
 * convert to a completion evaluation.
 */
import { describe, expect, it } from 'vitest';
import {
  lastVerificationRun,
  parseVerificationRunPayload,
  snapshotToCompletionEvaluation,
} from './sessionEvidence.js';

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    engine: 'kraken-legacy+completion-policy',
    strict: true,
    verdict: 'BLOCKED',
    legacy: { total: 2, passed: 1, failed: ['run tests'], unknown: [] },
    evidence: {
      satisfied: ['check-2-lint'],
      unsatisfied: [{ id: 'check-1-run-tests', status: 'fail', reason: 'exit 1' }],
      complete: false,
    },
    summary: 'blocked (strict BLOCKED): check-1-run-tests=fail',
    ...over,
  };
}

function ev(seq: number, data: Record<string, unknown>) {
  return { kind: 'verification.run', seq, ts: seq * 1000, data };
}

describe('sessionEvidence (E2.1)', () => {
  it('round-trips a BLOCKED record into a BLOCKED evaluation', () => {
    const snap = parseVerificationRunPayload(ev(3, payload()));
    expect(snap).not.toBeNull();
    expect(snap!.verdict).toBe('BLOCKED');
    expect(snap!.strict).toBe(true);
    const evaluation = snapshotToCompletionEvaluation(snap!);
    expect(evaluation!.verdict).toBe('BLOCKED');
    expect(evaluation!.unsatisfied).toEqual([
      { id: 'check-1-run-tests', status: 'fail', reason: 'exit 1' },
    ]);
    expect(evaluation!.evidenceComplete).toBe(false);
  });

  it('round-trips a PASS-with-evidence record', () => {
    const data = payload({
      verdict: 'PASS',
      legacy: { total: 1, passed: 1, failed: [], unknown: [] },
      evidence: { satisfied: ['check-1-run-tests'], unsatisfied: [], complete: true },
      summary: 'open (strict PASS)',
    });
    const evaluation = snapshotToCompletionEvaluation(parseVerificationRunPayload(ev(1, data))!);
    expect(evaluation!.verdict).toBe('PASS');
    expect(evaluation!.evidenceComplete).toBe(true);
    expect(evaluation!.unsatisfied).toEqual([]);
  });

  it('latest verification.run wins', () => {
    const events = [
      ev(1, payload({ verdict: 'PASS', evidence: { satisfied: ['a'], unsatisfied: [], complete: true } })),
      { kind: 'note', seq: 2, ts: 2, data: {} },
      ev(3, payload()),
    ];
    const snap = lastVerificationRun(events);
    expect(snap!.seq).toBe(3);
    expect(snap!.verdict).toBe('BLOCKED');
  });

  it('returns null for missing or malformed records (unknown ≠ pass)', () => {
    expect(lastVerificationRun([])).toBeNull();
    expect(lastVerificationRun([{ kind: 'note', seq: 1, ts: 1, data: {} }])).toBeNull();
    expect(parseVerificationRunPayload({ kind: 'verification.run', seq: 1, ts: 1 })).toBeNull();
    expect(
      parseVerificationRunPayload({ kind: 'verification.run', seq: 1, ts: 1, data: { verdict: 42 } }),
    ).not.toBeNull(); // parseable, but verdict degrades to unknown
    const unknown = parseVerificationRunPayload(
      ev(1, payload({ verdict: 'MAYBE' })),
    )!;
    expect(unknown.verdict).toBe('unknown');
    expect(snapshotToCompletionEvaluation(unknown)!.verdict).toBe('BLOCKED');
    expect(snapshotToCompletionEvaluation(unknown)!.evidenceComplete).toBe(false);
  });

  it('never converts a non-strict record into a completion evaluation', () => {
    const snap = parseVerificationRunPayload(ev(1, payload({ strict: false })))!;
    expect(snap.strict).toBe(false);
    expect(snap.verdict).toBe('BLOCKED'); // readable as a snapshot…
    expect(snapshotToCompletionEvaluation(snap)).toBeNull(); // …but not admissible
  });
});
