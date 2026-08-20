/**
 * verifierLifecycle tests — 2.1 T4: the core VerifierService joins the normal
 * headless lifecycle as an OPT-IN advisory pass.
 *
 * Locks:
 *  - opt-in rule: default (inherit, no env) OFF; fixed selection ON;
 *    ZELARI_VERIFIER_REVIEW=1 ON; =0 forces OFF even with a fixed override;
 *  - disabled → no review attached, evaluation untouched;
 *  - enabled → review attached and serialized in the verification.run payload
 *    (verifier.advisory = true) + its own spine event (source verifier-model);
 *  - ADVISORY ONLY at lifecycle level: a REJECTED review cannot block a PASS
 *    evaluation, a CONFIRMED review cannot un-block a REPAIR_REQUIRED one;
 *  - a failing verifier call degrades (declared discrete fallback) and never
 *    throws into the parent turn.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VerifierModelCaller } from '@zelari/core/verification';
import { runAdvisoryVerifierReview, verifierReviewEnabled } from './verifierLifecycle.js';
import {
  evaluateStrictBuildGate,
  strictGateEventPayload,
  type StrictBuildGateEvaluation,
} from './verificationBridge.js';
import { resetKrakenCandidates, setKrakenCheckResults, setKrakenSelection } from './candidateRegistry.js';

const CHECK = 'session survives concurrent refresh';

function emitSeq(): (input: unknown) => Promise<{ seq: number }> {
  let n = 1;
  const events: unknown[] = [];
  return async (input: unknown) => {
    events.push(input);
    void events;
    return { seq: n++ };
  };
}

/** Spine emitter that records every appended event (for review-event asserts). */
function recordingEmit(): {
  emit: (input: unknown) => Promise<{ seq: number }>;
  events: unknown[];
} {
  const events: unknown[] = [];
  let n = 1;
  return {
    events,
    emit: async (input: unknown) => {
      events.push(input);
      return { seq: n++ };
    },
  };
}

function selectWithChecks(checks: string[]): void {
  resetKrakenCandidates();
  setKrakenSelection({
    status: 'selected',
    winnerIndex: 0,
    rationale: 'test',
    requiredChecks: checks,
    degraded: false,
    verifier: null,
    judgedBy: 'llm',
  });
}

async function evaluatedGate(status: 'pass' | 'fail', emit?: (input: unknown) => Promise<{ seq: number }>): Promise<StrictBuildGateEvaluation> {
  selectWithChecks([CHECK]);
  setKrakenCheckResults([{ check: CHECK, status, note: 'vitest 58/58' }]);
  return evaluateStrictBuildGate('build', { env: {}, ...(emit ? { emit: emit as never } : {}) });
}

function stubCaller(text: string): VerifierModelCaller {
  return async () => ({ text, provider: 'grok', model: 'verifier-x' });
}

let envPrev: string | undefined;
beforeEach(() => {
  envPrev = process.env.ZELARI_STRICT_DONE;
  process.env.ZELARI_STRICT_DONE = '1';
  resetKrakenCandidates();
});
afterEach(() => {
  if (envPrev === undefined) delete process.env.ZELARI_STRICT_DONE;
  else process.env.ZELARI_STRICT_DONE = envPrev;
  resetKrakenCandidates();
});

describe('verifierReviewEnabled (opt-in rule)', () => {
  const inherit = { mode: 'inherit' as const };
  const fixed = { mode: 'fixed' as const, provider: 'grok', model: 'verifier-x' };

  it('default (inherit, no env) is OFF — zero baseline cost', () => {
    expect(verifierReviewEnabled(inherit, {})).toBe(false);
  });

  it('a dedicated (fixed) verifier enables the review', () => {
    expect(verifierReviewEnabled(fixed, {})).toBe(true);
  });

  it('ZELARI_VERIFIER_REVIEW=1 enables it even on inherit', () => {
    expect(verifierReviewEnabled(inherit, { ZELARI_VERIFIER_REVIEW: '1' })).toBe(true);
    expect(verifierReviewEnabled(inherit, { ZELARI_VERIFIER_REVIEW: 'true' })).toBe(true);
  });

  it('ZELARI_VERIFIER_REVIEW=0 forces OFF even with a fixed override', () => {
    expect(verifierReviewEnabled(fixed, { ZELARI_VERIFIER_REVIEW: '0' })).toBe(false);
    expect(verifierReviewEnabled(fixed, { ZELARI_VERIFIER_REVIEW: 'off' })).toBe(false);
  });
});

describe('runAdvisoryVerifierReview', () => {
  it('disabled → returns null and leaves the evaluation untouched', async () => {
    const gate = await evaluatedGate('pass', emitSeq());
    const review = await runAdvisoryVerifierReview(gate, {
      env: {},
      selection: { mode: 'inherit' },
      callModel: stubCaller('{"verdict":"confirmed"}'),
    });
    expect(review).toBeNull();
    expect(gate.review).toBeUndefined();
    expect(strictGateEventPayload(gate).verifier).toBeNull();
  });

  it('enabled → attaches the review and serializes it as advisory in the payload', async () => {
    const spine = recordingEmit();
    const gate = await evaluatedGate('pass', spine.emit);
    const review = await runAdvisoryVerifierReview(gate, {
      env: {},
      selection: { mode: 'fixed', provider: 'grok', model: 'verifier-x' },
      callModel: stubCaller('{"verdict":"confirmed","score":0.9,"rationale":"ok"}'),
      emit: spine.emit as never,
    });
    expect(review).not.toBeNull();
    expect(review?.verdict).toBe('confirmed');
    expect(gate.review?.verdict).toBe('confirmed');
    const payload = strictGateEventPayload(gate);
    expect(payload.verifier).toMatchObject({ verdict: 'confirmed', advisory: true });
    // Its own spine event, source-tagged verifier-model (VerifierService.emitReview).
    const reviewEvents = spine.events.filter(
      (e) => (e as { kind?: string; data?: { source?: string } }).data?.source === 'verifier-model',
    );
    expect(reviewEvents.length).toBe(1);
  });

  it('ADVISORY LOCK: a REJECTED review cannot block a PASS evaluation', async () => {
    const gate = await evaluatedGate('pass', emitSeq());
    await runAdvisoryVerifierReview(gate, {
      env: {},
      selection: { mode: 'fixed', provider: 'grok', model: 'verifier-x' },
      callModel: stubCaller('{"verdict":"rejected","rationale":"suspicious"}'),
    });
    expect(gate.review?.verdict).toBe('rejected');
    expect(gate.blocked).toBe(false);
    const payload = strictGateEventPayload(gate);
    expect(payload.verdict).not.toBe('BLOCKED');
    expect((payload.verifier as { verdict?: string } | null)?.verdict).toBe('rejected');
  });

  it('ADVISORY LOCK: a CONFIRMED review cannot un-block a failing evaluation', async () => {
    const gate = await evaluatedGate('fail', emitSeq());
    expect(gate.blocked).toBe(true);
    await runAdvisoryVerifierReview(gate, {
      env: {},
      selection: { mode: 'fixed', provider: 'grok', model: 'verifier-x' },
      callModel: stubCaller('{"verdict":"confirmed"}'),
    });
    // VerifierService itself downgrades confirm-on-failed-deterministic…
    expect(gate.review?.verdict).toBe('unknown');
    // …and the lifecycle keeps the deterministic verdict either way.
    expect(gate.blocked).toBe(true);
    expect(gate.evaluation?.verdict).toBe('REPAIR_REQUIRED');
  });

  it('a failing verifier call degrades (declared fallback) and never throws', async () => {
    const gate = await evaluatedGate('pass', emitSeq());
    const boom: VerifierModelCaller = async () => {
      throw new Error('provider 503');
    };
    const review = await runAdvisoryVerifierReview(gate, {
      env: {},
      selection: { mode: 'fixed', provider: 'grok', model: 'verifier-x' },
      callModel: boom,
    });
    expect(review?.verdict).toBe('unknown');
    expect(review?.fallback).toBe('discrete');
    expect(gate.blocked).toBe(false);
  });

  it('skips turns without strict evidence (nothing to review)', async () => {
    const gate: StrictBuildGateEvaluation = {
      gate: { selectionUsed: false, total: 0, passed: 0, failedChecks: [], unknownChecks: [], blocked: false },
      strict: false,
      evaluation: null,
      native: null,
      blocked: false,
      summary: 'open',
    };
    const review = await runAdvisoryVerifierReview(gate, {
      env: {},
      selection: { mode: 'fixed', provider: 'grok', model: 'verifier-x' },
      callModel: stubCaller('{"verdict":"confirmed"}'),
    });
    expect(review).toBeNull();
  });
});
