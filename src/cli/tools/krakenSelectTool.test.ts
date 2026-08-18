/**
 * krakenSelectTool.test — Fase 4 (ADR-0020) wiring tests for `kraken_select`:
 * empty-registry no-op, happy path with a mocked provider stream, verifier
 * unavailability degradation, and per-turn verdict storage.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderStreamFn } from '@zelari/core/harness';
import { createKrakenSelectTool, collectProviderText } from './krakenSelectTool.js';
import {
  getKrakenSelection,
  registerCandidate,
  resetKrakenCandidates,
} from '../kraken/candidateRegistry.js';
import { collectKrakenTurnMetrics, resetKrakenTurnMetrics } from '../kraken/metrics.js';

const verdictJson = (o: Record<string, unknown>) =>
  `<selection-verdict>\n${JSON.stringify(o, null, 2)}\n</selection-verdict>`;

function addOkCandidate(hypothesis: string): void {
  registerCandidate({
    status: 'ok',
    description: hypothesis,
    report: {
      hypothesis,
      evidence: [{ claim: `${hypothesis} observed`, basis: 'src/x.ts:10', degraded: false }],
      risks: [],
      hasDegradedEvidence: false,
    },
    raw: '',
  });
}

function streamReturning(text: string): ProviderStreamFn {
  return async function* () {
    yield { kind: 'text', delta: text };
    yield { kind: 'finish', reason: 'stop' };
  } as unknown as ProviderStreamFn;
}

const IDENTITY = { provider: 'grok', model: 'grok-4-fast' };

function makeTool(overrides: Partial<Parameters<typeof createKrakenSelectTool>[0]> = {}) {
  return createKrakenSelectTool({
    loadParentIdentity: async () => IDENTITY,
    loadStream: async () => streamReturning(verdictJson({ status: 'selected', winnerIndex: 1, rationale: 'r' })),
    ...overrides,
  });
}

const ctx = {} as never;

afterEach(() => {
  resetKrakenCandidates();
  resetKrakenTurnMetrics();
});

describe('kraken_select tool', () => {
  it('no candidates → typedOk no-op, no LLM, no stored verdict', async () => {
    let streamCalls = 0;
    const tool = makeTool({
      loadStream: async () => {
        streamCalls++;
        return streamReturning('');
      },
    });
    const res = await tool.execute({}, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.result).toContain('no candidates registered');
    expect(streamCalls).toBe(0);
    expect(getKrakenSelection()).toBeNull();
  });

  it('happy path: two candidates → selected verdict stored + readable result', async () => {
    addOkCandidate('race in refresh');
    addOkCandidate('cookie expiry');
    const tool = makeTool();
    const res = await tool.execute({ task: 'fix intermittent session loss' }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.result).toContain('SELECTED candidate #1');
      expect(res.value.result).not.toContain('degraded');
    }
    const v = getKrakenSelection();
    expect(v).toMatchObject({ status: 'selected', winnerIndex: 1, judgedBy: 'llm' });
    expect(v?.verifier).toEqual(IDENTITY);
  });

  it('parent identity unavailable → degraded needs_more_evidence, turn continues', async () => {
    addOkCandidate('a');
    addOkCandidate('b');
    const tool = makeTool({ loadParentIdentity: async () => null });
    const res = await tool.execute({}, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.result).toContain('NEEDS MORE EVIDENCE');
    expect(getKrakenSelection()?.degraded).toBe(true);
  });

  it('verifier provider config missing → degraded, not an error', async () => {
    addOkCandidate('a');
    addOkCandidate('b');
    const tool = makeTool({ loadStream: async () => null });
    const res = await tool.execute({}, ctx);
    expect(res.ok).toBe(true);
    const v = getKrakenSelection();
    expect(v?.degraded).toBe(true);
    expect(v?.fallbackReason).toBe('verifier call failed');
  });

  it('resetKrakenCandidates clears the stored verdict (per-turn lifecycle)', async () => {
    addOkCandidate('a');
    addOkCandidate('b');
    await makeTool().execute({}, ctx);
    expect(getKrakenSelection()).not.toBeNull();
    resetKrakenCandidates();
    expect(getKrakenSelection()).toBeNull();
  });

  it('env model override reaches the verifier identity', async () => {
    addOkCandidate('a');
    addOkCandidate('b');
    let seenModel = '';
    const tool = makeTool({
      env: { ZELARI_KRAKEN_SELECT_MODEL: 'glm-4.6' },
      loadStream: async () =>
        streamReturning(verdictJson({ status: 'selected', winnerIndex: 1 })),
    });
    // Intercept the model through collectProviderText params via a wrapping stream.
    const wrap: ProviderStreamFn = async function* (params: Parameters<ProviderStreamFn>[0]) {
      seenModel = params.model;
      yield { kind: 'text', delta: verdictJson({ status: 'selected', winnerIndex: 1 }) };
      yield { kind: 'finish', reason: 'stop' };
    } as unknown as ProviderStreamFn;
    const tool2 = createKrakenSelectTool({
      loadParentIdentity: async () => IDENTITY,
      loadStream: async () => wrap,
      env: { ZELARI_KRAKEN_SELECT_MODEL: 'glm-4.6' },
    });
    await tool.execute({}, ctx).catch(() => undefined);
    await tool2.execute({}, ctx);
    expect(seenModel).toBe('glm-4.6');
    expect(getKrakenSelection()?.verifier?.model).toBe('glm-4.6');
  });
});

describe('collectProviderText', () => {
  it('concatenates text deltas, stops at finish, ignores thinking; captures usage', async () => {
    const s: ProviderStreamFn = async function* () {
      yield { kind: 'thinking', delta: 'hmm' };
      yield { kind: 'text', delta: 'Hello ' };
      yield { kind: 'usage', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
      yield { kind: 'text', delta: 'world' };
      yield { kind: 'finish', reason: 'stop' };
      yield { kind: 'text', delta: 'after finish (ignored)' };
    } as unknown as ProviderStreamFn;
    const out = await collectProviderText(s, {
      messages: [],
      model: 'm',
      provider: 'p',
      tools: [],
    });
    expect(out.text).toBe('Hello world');
    expect(out.usage?.totalTokens).toBe(15);
  });

  it('returns no usage when the provider reports none', async () => {
    const s: ProviderStreamFn = async function* () {
      yield { kind: 'text', delta: 'x' };
      yield { kind: 'finish', reason: 'stop' };
    } as unknown as ProviderStreamFn;
    const out = await collectProviderText(s, {
      messages: [],
      model: 'm',
      provider: 'p',
      tools: [],
    });
    expect(out.text).toBe('x');
    expect(out.usage).toBeUndefined();
  });

  it('throws on error deltas (caller degrades gracefully)', async () => {
    const s: ProviderStreamFn = async function* () {
      yield { kind: 'error', message: 'boom' };
    } as unknown as ProviderStreamFn;
    await expect(
      collectProviderText(s, { messages: [], model: 'm', provider: 'p', tools: [] }),
    ).rejects.toThrow('boom');
  });
});

describe('kraken_select — Fase 9 verifier override wiring', () => {
  it('persisted override (loadVerifierOverride) → judging identity is the override', async () => {
    addOkCandidate('h1');
    addOkCandidate('h2');
    let seenProvider = '';
    let seenModel = '';
    const captureStream: ProviderStreamFn = async function* (
      params: Parameters<ProviderStreamFn>[0],
    ) {
      seenProvider = String((params as { provider?: string }).provider ?? '');
      seenModel = String((params as { model?: string }).model ?? '');
      yield { kind: 'text', delta: verdictJson({ status: 'selected', winnerIndex: 2, rationale: 'r' }) };
      yield { kind: 'finish', reason: 'stop' };
    } as unknown as ProviderStreamFn;
    const tool = makeTool({
      env: {},
      loadVerifierOverride: () => ({ provider: 'anthropic', model: 'claude-sonnet-4-6' }),
      loadStream: async () => captureStream,
    });
    const res = await tool.execute({ task: 't' }, ctx);
    expect(res.ok).toBe(true);
    // the judging call went to the OVERRIDE, not the parent identity
    expect(seenProvider).toBe('anthropic');
    expect(seenModel).toBe('claude-sonnet-4-6');
    expect(getKrakenSelection()?.verifier).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
  });

  it('no override → exact parent model (inherit default)', async () => {
    addOkCandidate('h1');
    addOkCandidate('h2');
    let seenProvider = '';
    const captureStream: ProviderStreamFn = async function* (
      params: Parameters<ProviderStreamFn>[0],
    ) {
      seenProvider = String((params as { provider?: string }).provider ?? '');
      yield { kind: 'text', delta: verdictJson({ status: 'selected', winnerIndex: 1, rationale: 'r' }) };
      yield { kind: 'finish', reason: 'stop' };
    } as unknown as ProviderStreamFn;
    const tool = makeTool({
      env: {},
      loadStream: async () => captureStream,
    });
    const res = await tool.execute({ task: 't' }, ctx);
    expect(res.ok).toBe(true);
    expect(seenProvider).toBe(IDENTITY.provider);
    expect(getKrakenSelection()?.verifier).toEqual(IDENTITY);
  });
});

describe('kraken_select — Fase 10 turn metrics', () => {
  it('records selection usage: latency + provider-reported tokens + fallback flag', async () => {
    addOkCandidate('race in refresh');
    addOkCandidate('cookie expiry');
    const tool = createKrakenSelectTool({
      loadParentIdentity: async () => IDENTITY,
      loadStream: async () =>
        (async function* () {
          yield { kind: 'text', delta: verdictJson({ status: 'selected', winnerIndex: 2, rationale: 'r' }) };
          yield { kind: 'usage', usage: { promptTokens: 400, completionTokens: 100, totalTokens: 500 } };
          yield { kind: 'finish', reason: 'stop' };
        }) as unknown as ProviderStreamFn,
    });
    const res = await tool.execute({ task: 'fix it' }, ctx);
    expect(res.ok).toBe(true);
    const m = collectKrakenTurnMetrics();
    expect(m).not.toBeNull();
    expect(m?.selectionUsed).toBe(true);
    expect(m?.candidateCount).toBe(2);
    expect(m?.selectionLatencyMs).toBeGreaterThanOrEqual(0);
    expect(m?.selectionTokens).toBe(500);
    expect(m?.selectionFallback).toBe(false);
    expect(m?.needsMoreEvidence).toBe(false);
  });

  it('records fallback on degraded verdicts (no stream available)', async () => {
    addOkCandidate('a');
    addOkCandidate('b');
    const tool = makeTool({ loadStream: async () => null });
    const res = await tool.execute({ task: 'x' }, ctx);
    expect(res.ok).toBe(true);
    const m = collectKrakenTurnMetrics();
    expect(m?.selectionFallback).toBe(true);
    expect(m?.selectionTokens).toBeUndefined();
  });
});
