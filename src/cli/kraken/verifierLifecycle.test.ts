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
import type { VerifierModelCaller, VerificationResult } from '@zelari/core/verification';
import {
  extractTestOutputExcerpt,
  runAdvisoryVerifierReview,
  verifierReviewEnabled,
} from './verifierLifecycle.js';
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
  return evaluateStrictBuildGate('build', { env: { ZELARI_VERIFY_PACK: '0' }, ...(emit ? { emit: emit as never } : {}) });
}

function stubCaller(text: string): VerifierModelCaller {
  return async () => ({ text, provider: 'grok', model: 'verifier-x' });
}

let envPrev: string | undefined;
beforeEach(() => {
  envPrev = process.env.ZELARI_STRICT_DONE;
  process.env.ZELARI_STRICT_DONE = '1';
  process.env.ZELARI_VERIFY_PACK = '0'; // P0.2 default ON - keep these suites hermetic
  resetKrakenCandidates();
});
afterEach(() => {
  if (envPrev === undefined) delete process.env.ZELARI_STRICT_DONE;
  else process.env.ZELARI_STRICT_DONE = envPrev;
  delete process.env.ZELARI_VERIFY_PACK;
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

describe('blind review input (P0.6)', () => {
  function spyCaller(text: string): {
    caller: VerifierModelCaller;
    calls: { system: string; user: string }[];
  } {
    const calls: { system: string; user: string }[] = [];
    const caller: VerifierModelCaller = async (input) => {
      calls.push(input);
      return { text, provider: 'grok', model: 'verifier-x' };
    };
    return { caller, calls };
  }

  function typecheckResult(): VerificationResult {
    return {
      criterionId: 'typecheck',
      status: 'pass',
      source: 'deterministic-engine',
      evidence: [{ tier: 'command-output', ref: 'tsc --noEmit', capturedAt: 0, digest: 'd'.repeat(64) }],
      evaluatedAt: 0,
      durationMs: 5,
      detail: 'exit 0',
    };
  }

  it('callModel spy: user JSON carries task + diffSummary + testOutputExcerpt, never narration', async () => {
    const gate = await evaluatedGate('pass', emitSeq());
    gate.results = [...(gate.results ?? []), typecheckResult()];
    const { caller, calls } = spyCaller('{"verdict":"confirmed","score":0.9}');
    await runAdvisoryVerifierReview(gate, {
      env: {},
      selection: { mode: 'fixed', provider: 'grok', model: 'verifier-x' },
      callModel: caller,
      task: '   make the flaky check deterministic   ',
      getDiff: async () => ({
        diff: 'diff --git a/x.ts b/x.ts\n+export const x = 1;',
        empty: false,
        truncated: false,
      }),
    });
    expect(calls).toHaveLength(1);
    const payload = JSON.parse(calls[0]?.user ?? '{}') as Record<string, unknown>;
    expect(payload.task).toBe('make the flaky check deterministic');
    expect(String(payload.diffSummary)).toContain('diff --git');
    expect(String(payload.testOutputExcerpt)).toContain('typecheck');
    expect(String(payload.testOutputExcerpt)).toContain('exit 0');
    // Blind payload keys are exactly the allowed evidence set.
    expect(Object.keys(payload).sort()).toEqual([
      'deterministicResults',
      'diffSummary',
      'summary',
      'task',
      'testOutputExcerpt',
    ]);
    for (const banned of ['reasoning', 'narration', 'builder', 'thoughts', 'assistant']) {
      expect(
        Object.keys(payload).some((k) => k.toLowerCase().includes(banned)),
      ).toBe(false);
    }
  });

  it('getDiff failure degrades: the review still runs without diffSummary', async () => {
    const gate = await evaluatedGate('pass', emitSeq());
    const { caller, calls } = spyCaller('{"verdict":"confirmed"}');
    const review = await runAdvisoryVerifierReview(gate, {
      env: {},
      selection: { mode: 'fixed', provider: 'grok', model: 'verifier-x' },
      callModel: caller,
      getDiff: async () => {
        throw new Error('git exploded');
      },
    });
    expect(review?.verdict).toBe('confirmed');
    const payload = JSON.parse(calls[0]?.user ?? '{}') as Record<string, unknown>;
    expect('diffSummary' in payload).toBe(false);
  });

  it('extractTestOutputExcerpt filters to test/typecheck/build/lint criteria and caps', () => {
    const excerpt = extractTestOutputExcerpt([
      { criterionId: 'check-1-selection-contract', status: 'pass', detail: 'ignored' },
      { criterionId: 'Typecheck', status: 'fail', detail: 'TS2304' },
      { criterionId: 'unit-tests', status: 'pass', detail: '58/58' },
    ]);
    expect(excerpt).toContain('Typecheck');
    expect(excerpt).toContain('unit-tests');
    expect(excerpt).not.toContain('selection-contract');
    expect(extractTestOutputExcerpt([])).toBe('');
    const big = extractTestOutputExcerpt(
      [{ criterionId: 'build', status: 'pass', detail: 'x'.repeat(1000) }],
      50,
    );
    expect(big.length).toBe(50);
  });

  it('inherit + familyCandidates routes the verifier identity to a different family', async () => {
    const gate = await evaluatedGate('pass', emitSeq());
    const loaded: string[] = [];
    const review = await runAdvisoryVerifierReview(gate, {
      env: { ZELARI_VERIFIER_REVIEW: 'true' },
      selection: { mode: 'inherit' },
      session: { provider: 'openai', model: 'gpt-5' },
      familyCandidates: [
        { provider: 'openai', model: 'gpt-5-mini' },
        { provider: 'grok', model: 'grok-4' },
      ],
      loadStream: async (provider, model) => {
        loaded.push(`${provider}/${model}`);
        return null;
      },
    });
    expect(loaded).toEqual(['grok/grok-4']); // first different-family candidate wins
    expect(review?.fallback).toBe('discrete'); // null stream degrades, never throws
  });

  it('inherit without familyCandidates keeps the session identity verbatim', async () => {
    const gate = await evaluatedGate('pass', emitSeq());
    const loaded: string[] = [];
    await runAdvisoryVerifierReview(gate, {
      env: { ZELARI_VERIFIER_REVIEW: 'true' },
      selection: { mode: 'inherit' },
      session: { provider: 'openai', model: 'gpt-5' },
      loadStream: async (provider, model) => {
        loaded.push(`${provider}/${model}`);
        return null;
      },
    });
    expect(loaded).toEqual(['openai/gpt-5']);
  });

  it('ZELARI_KRAKEN_CROSS_MODEL=0 keeps the session identity even with candidates', async () => {
    const gate = await evaluatedGate('pass', emitSeq());
    const loaded: string[] = [];
    await runAdvisoryVerifierReview(gate, {
      env: { ZELARI_VERIFIER_REVIEW: 'true', ZELARI_KRAKEN_CROSS_MODEL: '0' },
      selection: { mode: 'inherit' },
      session: { provider: 'openai', model: 'gpt-5' },
      familyCandidates: [{ provider: 'anthropic', model: 'claude-sonnet-4' }],
      loadStream: async (provider, model) => {
        loaded.push(`${provider}/${model}`);
        return null;
      },
    });
    expect(loaded).toEqual(['openai/gpt-5']);
  });
});
