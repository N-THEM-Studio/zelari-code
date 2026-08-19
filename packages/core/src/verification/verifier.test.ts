import { describe, expect, it } from 'vitest';
import { evaluateCompletion } from './completionPolicy.js';
import {
  DEFAULT_VERIFIER_CONFIG,
  VerifierService,
  type VerifierConfig,
  type VerifierModelResponse,
} from './verifier.js';
import type { SessionEventInput } from '../session/types.js';
import type { Criterion, VerificationResult } from './types.js';

function result(criterionId: string, status: VerificationResult['status']): VerificationResult {
  return {
    criterionId,
    status,
    source: 'deterministic-engine',
    evidence: [{ tier: 'command-output', ref: 'cmd', capturedAt: 0, digest: 'd'.repeat(64) }],
    evaluatedAt: 0,
    durationMs: 3,
  };
}

function service(
  response: VerifierModelResponse | Error,
  config: Partial<VerifierConfig> = {},
  emitted: SessionEventInput[] = [],
): VerifierService {
  return new VerifierService({
    callModel: async () => {
      if (response instanceof Error) throw response;
      return response;
    },
    config: { ...DEFAULT_VERIFIER_CONFIG, ...config, model: config.model ?? { mode: 'inherit' }, bon: { enabled: false, n: 3, ...(config.bon ?? {}) } },
    emit: async (input) => {
      emitted.push(input);
    },
    env: {},
  });
}

const criteria: Criterion[] = [{ id: 'tests', text: 'tests pass', source: 'task', required: true }];

describe('VerifierService (advisory, alpha)', () => {
  it('is disabled by default and degrades to a declared discrete fallback', async () => {
    const s = service({ text: '' });
    const review = await s.reviewCompletion({ summary: 'done', results: [result('tests', 'pass')] });
    expect(review.verdict).toBe('unknown');
    expect(review.fallback).toBe('discrete');
    expect(review.rationale).toContain('disabled');
  });

  it('parses the model JSON and logs the effective model in the spine event', async () => {
    const emitted: SessionEventInput[] = [];
    const s = service(
      { text: '```json\n{"verdict":"confirmed","score":0.91,"rationale":"ok"}\n```', provider: 'anthropic', model: 'sonnet' },
      { enabled: true },
      emitted,
    );
    const review = await s.reviewCompletion({
      summary: 'done',
      results: [result('tests', 'pass')],
      session: { provider: 'openai', model: 'gpt' },
    });
    expect(review.verdict).toBe('confirmed');
    expect(review.score).toBeCloseTo(0.91);
    // In inherit mode the CALLER's response is the effective truth (it knows
    // what actually served the request), overriding the session default.
    expect(review.effectiveModel).toEqual({ mode: 'inherit', provider: 'anthropic', model: 'sonnet' });
    expect(emitted).toHaveLength(1);
    const data = emitted[0]?.data as Record<string, unknown>;
    expect(data.source).toBe('verifier-model');
    expect(data.model).toBe('sonnet');
    expect(data.selectionMode).toBe('inherit');
  });

  it('fixed model selection overrides the session model', async () => {
    const s = service({ text: '{"verdict":"unknown"}', provider: 'grok', model: 'grok-4' }, {
      enabled: true,
      model: { mode: 'fixed', provider: 'grok', model: 'grok-4' },
    });
    const review = await s.reviewCompletion({
      summary: 'x',
      results: [],
      session: { provider: 'openai', model: 'gpt' },
    });
    expect(review.effectiveModel).toEqual({ mode: 'fixed', provider: 'grok', model: 'grok-4' });
  });

  it('unparseable output → declared discrete fallback, never pass', async () => {
    const s = service({ text: 'I think it looks fine!' }, { enabled: true });
    const review = await s.reviewCompletion({ summary: 'x', results: [result('tests', 'pass')] });
    expect(review.verdict).toBe('unknown');
    expect(review.fallback).toBe('discrete');
  });

  it('never confirms over a failed deterministic check (no P2 bypass)', async () => {
    const s = service({ text: '{"verdict":"confirmed","score":0.99}' }, { enabled: true });
    const review = await s.reviewCompletion({ summary: 'done', results: [result('tests', 'fail')] });
    expect(review.verdict).toBe('unknown');
    expect(review.fallback).toBe('discrete');
  });

  it('ADVISORY ONLY: a confirmed review cannot flip the CompletionPolicy', () => {
    const review = { verdict: 'confirmed' as const, score: 0.99 };
    const evaluation = evaluateCompletion(criteria, [result('tests', 'fail')]);
    expect(evaluation.verdict).toBe('REPAIR_REQUIRED');
    expect(review.verdict).toBe('confirmed'); // the review exists…
    // …but completion is driven exclusively by deterministic results.
    const passEvaluation = evaluateCompletion(criteria, [result('tests', 'pass')]);
    expect(passEvaluation.verdict).toBe('PASS');
  });

  it('model call failure degrades to unknown with the reason', async () => {
    const s = service(new Error('503 overloaded'), { enabled: true });
    const review = await s.reviewCompletion({ summary: 'x', results: [] });
    expect(review.verdict).toBe('unknown');
    expect(review.rationale).toContain('503');
  });
});

describe('VerifierService ranking / BoN / progress', () => {
  it('ranks by score; without scores keeps order with declared fallback', () => {
    const s = service({ text: '' });
    const ranked = s.rankHypotheses([
      { id: 'h1', score: 0.4 },
      { id: 'h2', score: 0.8 },
    ]);
    expect(ranked.ordered.map((h) => h.id)).toEqual(['h2', 'h1']);
    expect(ranked.fallbackUsed).toBe(false);
    const fallback = s.rankHypotheses([{ id: 'a' }, { id: 'b' }]);
    expect(fallback.ordered.map((h) => h.id)).toEqual(['a', 'b']);
    expect(fallback.fallbackUsed).toBe(true);
  });

  it('BoN requires config AND the experimental flag; ties declare fallback', () => {
    const off = service({ text: '' });
    expect(off.selectBestN([{ id: 'a', score: 0.9 }]).enabled).toBe(false);

    const on = service({ text: '' }, { bon: { enabled: true, n: 3 } });
    // env is {} in the service fixture → experimental flag off → still disabled
    expect(on.selectBestN([{ id: 'a', score: 0.9 }]).enabled).toBe(false);
    expect(on.selectBestN([{ id: 'a', score: 0.9 }]).reason).toContain('ZELARI_EXPERIMENTAL');

    const bon = new VerifierService({
      callModel: async () => ({ text: '' }),
      config: { ...DEFAULT_VERIFIER_CONFIG, bon: { enabled: true, n: 3 } },
      env: { ZELARI_EXPERIMENTAL: 'bon' },
    });
    const clear = bon.selectBestN([
      { id: 'a', score: 0.9 },
      { id: 'b', score: 0.3 },
    ]);
    expect(clear).toMatchObject({ enabled: true, selected: 'a', fallbackUsed: false });
    const tie = bon.selectBestN([
      { id: 'a', score: 0.51 },
      { id: 'b', score: 0.5 },
    ]);
    expect(tie.fallbackUsed).toBe(true);
    expect(tie.selected).toBe('a');
    expect(tie.reason).toContain('fallback');
  });

  it('progress score is epistemically honest (experimental label, never % complete)', () => {
    const det = service({ text: '' }, { enabled: true }).progressScore([result('a', 'pass'), result('b', 'fail')]);
    expect(det).toEqual({ tier: 'deterministic', value: 0.5, label: 'Evidence: 1/2 criteria pass' });

    const s = service({ text: '' }, { enabled: true, progressScoring: true });

    const blended = s.progressScore(
      [result('a', 'pass'), result('b', 'fail')],
      { verdict: 'confirmed', score: 0.8, effectiveModel: { mode: 'inherit' }, usedLogprobs: false },
    );
    expect(blended.tier).toBe('blended');
    expect(blended.label).toContain('experimental');
    expect(blended.label).not.toContain('%');
  });
});
