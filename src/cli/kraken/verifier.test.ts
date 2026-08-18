/**
 * verifier.test — Fase 4 (ADR-0020) unit tests for the Kraken selection
 * verifier: identity resolution (parent-exact default), judging prompt
 * rules, lenient verdict parsing, and the never-throw fallback contract.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSelectionPrompt,
  parseSelectionVerdict,
  resolveKrakenVerifier,
  runKrakenSelection,
  VERIFIER_SYSTEM_PROMPT,
  type KrakenVerifierIdentity,
} from './verifier.js';
import type { CandidateEntry } from './candidateRegistry.js';

const PARENT: KrakenVerifierIdentity = { provider: 'grok', model: 'grok-4-fast' };

function okCandidate(index: number, hypothesis: string, opts: Partial<CandidateEntry> & { degraded?: boolean } = {}): CandidateEntry {
  return {
    status: 'ok',
    index,
    description: `candidate ${index}`,
    report: {
      hypothesis,
      evidence: [
        { claim: `claim-${index}`, basis: `file:${index}`, degraded: opts.degraded === true },
      ],
      risks: [],
      hasDegradedEvidence: opts.degraded === true,
    },
    raw: '',
  } as CandidateEntry;
}

function malformedCandidate(index: number): CandidateEntry {
  return {
    status: 'malformed',
    index,
    description: `candidate ${index}`,
    error: 'missing report block',
    raw: 'no block',
  } as CandidateEntry;
}

const verdictJson = (o: Record<string, unknown>) =>
  `<selection-verdict>\n${JSON.stringify(o, null, 2)}\n</selection-verdict>`;

// ── resolveKrakenVerifier ──────────────────────────────────────────────────

describe('resolveKrakenVerifier', () => {
  it('defaults to the EXACT parent identity (no cheap-model routing)', () => {
    expect(resolveKrakenVerifier(PARENT, {})).toEqual(PARENT);
  });

  it('model-only env keeps parent provider, overrides model', () => {
    expect(resolveKrakenVerifier(PARENT, { ZELARI_KRAKEN_SELECT_MODEL: 'glm-4.6' })).toEqual({
      provider: 'grok',
      model: 'glm-4.6',
    });
  });

  it('provider+model env fully overrides', () => {
    expect(
      resolveKrakenVerifier(PARENT, {
        ZELARI_KRAKEN_SELECT_PROVIDER: 'openai-compatible',
        ZELARI_KRAKEN_SELECT_MODEL: 'gpt-5',
      }),
    ).toEqual({ provider: 'openai-compatible', model: 'gpt-5' });
  });

  it('provider-only env is invalid → falls back to parent (§64)', () => {
    expect(resolveKrakenVerifier(PARENT, { ZELARI_KRAKEN_SELECT_PROVIDER: 'glm' })).toEqual(PARENT);
  });

  it('explicit settings override (Fase 9) wins over env', () => {
    expect(
      resolveKrakenVerifier(
        PARENT,
        { ZELARI_KRAKEN_SELECT_MODEL: 'env-model' },
        { provider: 'anthropic', model: 'claude-x' },
      ),
    ).toEqual({ provider: 'anthropic', model: 'claude-x' });
  });

  it('partial explicit override is ignored → env applies', () => {
    expect(
      resolveKrakenVerifier(PARENT, { ZELARI_KRAKEN_SELECT_MODEL: 'env-model' }, { model: 'x' }),
    ).toEqual({ provider: 'grok', model: 'env-model' });
  });
});

// ── Prompt ─────────────────────────────────────────────────────────────────

describe('buildSelectionPrompt / system rules', () => {
  it('system prompt carries the evidence-integrity rules', () => {
    expect(VERIFIER_SYSTEM_PROMPT).toContain('NOT proof of absence');
    expect(VERIFIER_SYSTEM_PROMPT).toContain('Evidence decides');
    expect(VERIFIER_SYSTEM_PROMPT).toContain('needs_more_evidence');
  });

  it('renders hypotheses, degraded tags and malformed candidates', () => {
    const p = buildSelectionPrompt('fix session loss', [
      okCandidate(1, 'token rotation race'),
      okCandidate(2, 'cookie expiry bug', { degraded: true }),
      malformedCandidate(3),
    ]);
    expect(p).toContain('TASK');
    expect(p).toContain('Candidate #1 — token rotation race');
    expect(p).toContain('DEGRADED — inconclusive, NOT proof of absence');
    expect(p).toContain('Candidate #3 — UNUSABLE');
    expect(p).toContain('claim-1 (basis: file:1)');
  });
});

// ── parseSelectionVerdict ──────────────────────────────────────────────────

describe('parseSelectionVerdict', () => {
  const two = [okCandidate(1, 'h1'), okCandidate(2, 'h2')];

  it('accepts a valid selected verdict', () => {
    const r = parseSelectionVerdict(
      verdictJson({ status: 'selected', winnerIndex: 2, rationale: 'grounded', requiredChecks: ['test:session'] }),
      two,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.verdict.status).toBe('selected');
      expect(r.verdict.winnerIndex).toBe(2);
      expect(r.verdict.requiredChecks).toEqual(['test:session']);
      expect(r.verdict.degraded).toBe(false);
    }
  });

  it('accepts needs_more_evidence and ignores any winner', () => {
    const r = parseSelectionVerdict(
      verdictJson({ status: 'needs_more_evidence', winnerIndex: 1, rationale: 'tie' }),
      two,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict.winnerIndex).toBeNull();
  });

  it('rejects non-integer winnerIndex', () => {
    expect(parseSelectionVerdict(verdictJson({ status: 'selected', winnerIndex: 1.5 }), two)).toMatchObject({ ok: false });
    expect(parseSelectionVerdict(verdictJson({ status: 'selected', winnerIndex: '2' }), two)).toMatchObject({ ok: false });
  });

  it('rejects a winner pointing at a malformed candidate', () => {
    const r = parseSelectionVerdict(
      verdictJson({ status: 'selected', winnerIndex: 3 }),
      [okCandidate(1, 'h1'), okCandidate(2, 'h2'), malformedCandidate(3)],
    );
    expect(r).toMatchObject({ ok: false });
  });

  it('rejects missing block / invalid JSON / bad status', () => {
    expect(parseSelectionVerdict('no block here', two)).toMatchObject({ ok: false });
    expect(parseSelectionVerdict('<selection-verdict>{bad json}</selection-verdict>', two)).toMatchObject({ ok: false });
    expect(parseSelectionVerdict(verdictJson({ status: 'maybe' }), two)).toMatchObject({ ok: false });
  });

  it('clamps requiredChecks to 5 and drops non-strings', () => {
    const r = parseSelectionVerdict(
      verdictJson({
        status: 'selected',
        winnerIndex: 1,
        requiredChecks: ['a', 'b', 'c', 'd', 'e', 'f', 42, null],
      }),
      two,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict.requiredChecks).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('uses the LAST verdict block when the model rambles', () => {
    const raw = `prose <selection-verdict>{"status":"needs_more_evidence"}</selection-verdict> more prose
<selection-verdict>{"status":"selected","winnerIndex":1}</selection-verdict>`;
    const r = parseSelectionVerdict(raw, two);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict.status).toBe('selected');
  });
});

// ── runKrakenSelection ─────────────────────────────────────────────────────

describe('runKrakenSelection', () => {
  it('zero usable candidates → deterministic needs_more_evidence, no LLM call', async () => {
    let called = 0;
    const v = await runKrakenSelection({
      task: 't',
      candidates: [malformedCandidate(1), malformedCandidate(2)],
      identity: PARENT,
      callModel: async () => {
        called++;
        return '';
      },
    });
    expect(called).toBe(0);
    expect(v.status).toBe('needs_more_evidence');
    expect(v.degraded).toBe(true);
    expect(v.fallbackReason).toBe('no usable candidates');
  });

  it('single usable candidate → deterministic selection, no LLM call', async () => {
    let called = 0;
    const v = await runKrakenSelection({
      task: 't',
      candidates: [okCandidate(1, 'only'), malformedCandidate(2)],
      identity: PARENT,
      callModel: async () => {
        called++;
        return '';
      },
    });
    expect(called).toBe(0);
    expect(v.status).toBe('selected');
    expect(v.winnerIndex).toBe(1);
    expect(v.judgedBy).toBe('deterministic');
  });

  it('two candidates → LLM judges with system+user and identity rides the verdict', async () => {
    let seen: { system: string; user: string } | null = null;
    const v = await runKrakenSelection({
      task: 'fix intermittent session loss',
      candidates: [okCandidate(1, 'race in refresh'), okCandidate(2, 'cookie expiry')],
      identity: PARENT,
      callModel: async ({ system, user }) => {
        seen = { system, user };
        return verdictJson({
          status: 'selected',
          winnerIndex: 1,
          rationale: 'grounded in file evidence',
          requiredChecks: ['regression test for concurrent refresh'],
        });
      },
    });
    expect(seen).not.toBeNull();
    expect(seen!.system).toContain('selection verifier');
    expect(seen!.user).toContain('fix intermittent session loss');
    expect(v).toMatchObject({
      status: 'selected',
      winnerIndex: 1,
      judgedBy: 'llm',
      degraded: false,
      verifier: PARENT,
    });
    expect(v.requiredChecks).toEqual(['regression test for concurrent refresh']);
  });

  it('model says tie → clean needs_more_evidence (not degraded)', async () => {
    const v = await runKrakenSelection({
      task: 't',
      candidates: [okCandidate(1, 'a'), okCandidate(2, 'b')],
      identity: PARENT,
      callModel: async () =>
        verdictJson({ status: 'needs_more_evidence', rationale: 'equally supported' }),
    });
    expect(v.status).toBe('needs_more_evidence');
    expect(v.degraded).toBe(false);
    expect(v.judgedBy).toBe('llm');
  });

  it('callModel throws (timeout/429/network) → degraded, run continues', async () => {
    const v = await runKrakenSelection({
      task: 't',
      candidates: [okCandidate(1, 'a'), okCandidate(2, 'b')],
      identity: PARENT,
      callModel: async () => {
        throw new Error('429 rate limited');
      },
    });
    expect(v.status).toBe('needs_more_evidence');
    expect(v.degraded).toBe(true);
    expect(v.fallbackReason).toBe('verifier call failed');
    expect(v.rationale).toContain('429');
  });

  it('malformed verifier response → degraded with reason', async () => {
    const v = await runKrakenSelection({
      task: 't',
      candidates: [okCandidate(1, 'a'), okCandidate(2, 'b')],
      identity: PARENT,
      callModel: async () => 'I think candidate 1 is nicer',
    });
    expect(v.status).toBe('needs_more_evidence');
    expect(v.degraded).toBe(true);
    expect(v.fallbackReason).toContain('malformed verifier response');
  });
});
