/**
 * verificationBridge.session — Exit-2/E2.1 spine round-trip.
 *
 * The strict build gate decision must be reconstructible from the session
 * log alone: evaluate → `strictGateEventPayload` → spine append → replay →
 * `evaluateStrictBuildGateFromSession` yields the same verdict. A missing
 * record is "no evidence" (open, not pass); a non-strict record is not
 * admissible.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readSessionLog, resolveSessionsDir } from '@zelari/core/session';
import { lastVerificationRun } from '@zelari/core/verification';
import {
  evaluateStrictBuildGateFromSession,
  strictGateEventPayload,
  type StrictBuildGateEvaluation,
} from './verificationBridge.js';
import type { KrakenCompletionGate } from './completionGate.js';
import { openHeadlessSpine } from '../headlessSpine.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-verify-spine-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function eventsPath(sessionId: string): string {
  return path.join(resolveSessionsDir({ baseDir: tmp }), sessionId, 'events.jsonl');
}

function fakeGate(blocked: boolean): KrakenCompletionGate {
  return {
    selectionUsed: true,
    total: 2,
    passed: blocked ? 1 : 2,
    failedChecks: blocked ? ['run tests'] : [],
    unknownChecks: [],
    blocked,
  } as unknown as KrakenCompletionGate;
}

function fakeStrictEvaluation(verdict: 'PASS' | 'BLOCKED'): StrictBuildGateEvaluation {
  if (verdict === 'PASS') {
    return {
      gate: fakeGate(false),
      strict: true,
      evaluation: {
        verdict: 'PASS',
        satisfied: ['check-1-run-tests', 'check-2-lint'],
        unsatisfied: [],
        evidenceComplete: true,
        summary: 'open (strict PASS): 2/2 criteria pass with evidence',
      },
      blocked: false,
      summary: 'open (strict PASS)',
    };
  }
  return {
    gate: fakeGate(true),
    strict: true,
    evaluation: {
      verdict: 'BLOCKED',
      satisfied: ['check-2-lint'],
      unsatisfied: [{ id: 'check-1-run-tests', status: 'fail', reason: 'exit 1' }],
      evidenceComplete: false,
      summary: 'incomplete (BLOCKED): check-1-run-tests=fail',
    },
    blocked: true,
    summary: 'blocked (strict BLOCKED)',
  };
}

describe('evaluateStrictBuildGateFromSession (E2.1)', () => {
  it('round-trips a BLOCKED verdict through the spine log', async () => {
    const handle = await openHeadlessSpine({ sessionId: 'verify-resume', baseDir: tmp, quiet: true });
    handle.verificationRun(strictGateEventPayload(fakeStrictEvaluation('BLOCKED')));
    await handle.spine.flush();

    const report = await readSessionLog(eventsPath('verify-resume'));
    const snap = lastVerificationRun(report.events);
    expect(snap).not.toBeNull();
    expect(snap!.verdict).toBe('BLOCKED');

    const fromSession = evaluateStrictBuildGateFromSession('build', snap);
    expect(fromSession.blocked).toBe(true);
    expect(fromSession.strict).toBe(true);
    expect(fromSession.evaluation!.verdict).toBe('BLOCKED');
    expect(fromSession.evaluation!.unsatisfied[0].id).toBe('check-1-run-tests');
    expect(fromSession.summary).toContain(`seq=${snap!.seq}`); // traces back to the log
    await handle.close('test-done');
  });

  it('round-trips a PASS-with-evidence verdict', async () => {
    const handle = await openHeadlessSpine({ sessionId: 'verify-pass', baseDir: tmp, quiet: true });
    handle.verificationRun(strictGateEventPayload(fakeStrictEvaluation('PASS')));
    await handle.spine.flush();

    const report = await readSessionLog(eventsPath('verify-pass'));
    const fromSession = evaluateStrictBuildGateFromSession(
      'build',
      lastVerificationRun(report.events),
    );
    expect(fromSession.blocked).toBe(false);
    expect(fromSession.evaluation!.verdict).toBe('PASS');
    expect(fromSession.evaluation!.evidenceComplete).toBe(true);
    await handle.close('test-done');
  });

  it('treats a missing record as no evidence — open, never pass', () => {
    const fromSession = evaluateStrictBuildGateFromSession('build', null);
    expect(fromSession.blocked).toBe(false);
    expect(fromSession.strict).toBe(false);
    expect(fromSession.evaluation).toBeNull();
    expect(fromSession.summary).toContain('no strict verification record');
  });
});
