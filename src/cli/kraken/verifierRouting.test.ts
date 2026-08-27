/**
 * verifierRouting tests — t21 (§P1.D × PW §10): risk-based cross-family
 * verifier routing on top of the P0.6 default.
 *
 * Locks:
 *  - routing table: low ⇒ 0 reviewers (reviewer OFF, deterministic only);
 *    medium ⇒ 1 ECONOMICAL different-family reviewer; high ⇒ 1 STRONGEST
 *    different-family reviewer; critical ⇒ 2 reviewers from two DIFFERENT
 *    families, neither equal to the builder family;
 *  - P0.6 parity: fixed dedicated selections stay verbatim; same-family
 *    fallback keeps the session identity EXACTLY as before (never a worse
 *    model than the pre-t21 pick);
 *  - activeRisk precedence: ZELARI_VERIFY_RISK env > active TaskContract
 *    (t22 seam via setActiveContractScope) > 'medium'; invalid env ignored;
 *  - pessimistic merge: rejected > unknown > confirmed; divergence detection;
 *  - BLIND INPUT property (formalizes P0.6): reviewer-visible fields are
 *    strictly task / deterministic summary / diff summary / test output
 *    excerpt / deterministic results — builder narration has NO channel.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskContract } from '@zelari/core';
import type { VerifierReview } from '@zelari/core/verification';
import { deriveInitialContract } from '@zelari/core';
import { setActiveContractScope } from './contractCompiler.js';
import {
  activeRisk,
  divergenceFromReviews,
  mergeVerifierVerdicts,
  resolveVerifierRouting,
  setReputationSource,
  verdictsDiverge,
  VERIFY_RISK_ENV,
} from './verifierRouting.js';
import { REPUTATION_MIN_SAMPLE, type ReputationRecord } from './modelReputation.js';
import { buildBlindReviewInput } from './verifierLifecycle.js';
import type { StrictBuildGateEvaluation } from './verificationBridge.js';

const BUILDER = { provider: 'openai', model: 'gpt-5' };
/** Two families besides the builder's, each with a cheap and a strong pick. */
const CANDIDATES = [
  { provider: 'anthropic', model: 'claude-opus-4' }, // strong (flagship-ish id)
  { provider: 'anthropic', model: 'claude-haiku-3' }, // cheap heuristic hit
  { provider: 'grok', model: 'grok-4' },
  { provider: 'openai', model: 'gpt-5-mini' }, // same family as builder — unusable for cross pick
];

function noContract(): void {
  setActiveContractScope(undefined);
}
afterEach(noContract);

describe('resolveVerifierRouting (routing table)', () => {
  it('low ⇒ zero reviewers, reviewer OFF (deterministic verification only)', () => {
    const d = resolveVerifierRouting(BUILDER, 'low', {
      selectionMode: 'inherit',
      session: BUILDER,
      familyCandidates: CANDIDATES,
      env: {},
    });
    expect(d.risk).toBe('low');
    expect(d.reviewers).toEqual([]);
    expect(d.rationaleCode).toBe('reviewer-off-low-risk-deterministic-only');
  });

  it('medium ⇒ 1 ECONOMICAL reviewer from a family ≠ builder family', () => {
    const d = resolveVerifierRouting(BUILDER, 'medium', {
      selectionMode: 'inherit',
      session: BUILDER,
      familyCandidates: CANDIDATES,
      env: {},
    });
    expect(d.reviewers).toHaveLength(1);
    const r = d.reviewers[0]!;
    expect(r.role).toBe('economical');
    expect(r.family).not.toBe('openai');
    expect(r.identity.provider).toBe('anthropic');
    // cheap signal applied WITHIN the chosen family: haiku beats opus
    expect(r.identity.model).toBe('claude-haiku-3');
    expect(d.rationaleCode).toBe('cross-family-economical');
  });

  it('high ⇒ 1 STRONGEST reviewer from a family ≠ builder family', () => {
    const d = resolveVerifierRouting(BUILDER, 'high', {
      selectionMode: 'inherit',
      session: BUILDER,
      familyCandidates: CANDIDATES,
      env: {},
    });
    expect(d.reviewers).toHaveLength(1);
    const r = d.reviewers[0]!;
    expect(r.role).toBe('strongest');
    expect(r.family).not.toBe('openai');
    expect(r.identity.model).toBe('claude-opus-4');
    expect(d.rationaleCode).toBe('cross-family-strongest-available');
  });

  it('critical ⇒ 2 reviewers from two DIFFERENT families, neither = builder', () => {
    const d = resolveVerifierRouting(BUILDER, 'critical', {
      selectionMode: 'inherit',
      session: BUILDER,
      familyCandidates: CANDIDATES,
      env: {},
    });
    expect(d.reviewers).toHaveLength(2);
    const [a, b] = d.reviewers.map((r) => r);
    expect(a!.role).toBe('strongest');
    expect(b!.role).toBe('second-opinion');
    const families = [a!.family, b!.family];
    expect(new Set(families).size).toBe(2);
    for (const f of families) expect(f).not.toBe('openai');
    expect(d.rationaleCode).toBe('critical-dual-cross-family-pessimistic-merge');
  });

  it('P0.6 parity: fixed dedicated selection stays verbatim (single reviewer even at critical)', () => {
    const fixedIdentity = { provider: 'grok', model: 'verifier-x' };
    for (const risk of ['medium', 'high', 'critical'] as const) {
      const d = resolveVerifierRouting(fixedIdentity, risk, {
        selectionMode: 'fixed',
        familyCandidates: CANDIDATES,
        env: {},
      });
      expect(d.reviewers).toHaveLength(1);
      expect(d.reviewers[0]!.identity).toEqual(fixedIdentity);
    }
  });

  it('P0.6 parity: same-family fallback keeps the SESSION model untouched', () => {
    const session = { provider: 'zhipu', model: 'glm-4.7-air' };
    const sameFamilyOnly = [{ provider: 'zhipu', model: 'glm-4-flash' }];
    for (const risk of ['medium', 'high'] as const) {
      const d = resolveVerifierRouting(null, risk, {
        selectionMode: 'inherit',
        session,
        familyCandidates: sameFamilyOnly,
        env: {},
      });
      expect(d.reviewers[0]!.identity).toEqual(session); // NOT glm-4-flash
      expect(d.rationaleCode).toBe(`same-family-fallback-${risk}`);
    }
  });

  it('critical degrades explicitly when independence cannot be sourced', () => {
    // Not even one different family → single reviewer, declared degrade.
    const none = resolveVerifierRouting(BUILDER, 'critical', {
      selectionMode: 'inherit',
      session: BUILDER,
      familyCandidates: [{ provider: 'openai', model: 'gpt-5-mini' }],
      env: {},
    });
    expect(none.rationaleCode).toBe('critical-single-same-family-degraded');
    expect(none.reviewers).toHaveLength(1);

    // One different family, no distinct alternative → drop the second reviewer.
    const thin = resolveVerifierRouting(BUILDER, 'critical', {
      selectionMode: 'inherit',
      session: BUILDER,
      familyCandidates: [{ provider: 'grok', model: 'grok-4' }],
      env: {},
    });
    expect(thin.rationaleCode).toBe('critical-single-cross-family-degraded');

    // Second reviewer may fall back to ANOTHER MODEL within the one other family.
    const alt = resolveVerifierRouting(BUILDER, 'critical', {
      selectionMode: 'inherit',
      session: BUILDER,
      familyCandidates: [
        { provider: 'grok', model: 'grok-4' },
        { provider: 'grok', model: 'grok-heavy' },
      ],
      env: {},
    });
    expect(alt.rationaleCode).toBe('critical-second-reviewer-same-family');
    expect(alt.reviewers).toHaveLength(2);
    expect(alt.reviewers.every((r) => r.family !== 'openai')).toBe(true);
  });
});

describe('activeRisk (precedence)', () => {
  function contractWith(risk: TaskContract['risk']): TaskContract {
    const base = deriveInitialContract(1, 'test mission');
    return { ...base, ...(risk !== undefined ? { risk } : {}) } as TaskContract;
  }

  it('no contract, no env ⇒ medium', () => {
    expect(activeRisk({})).toBe('medium');
  });

  it('contract beats fallback', () => {
    setActiveContractScope(contractWith('high'));
    try {
      expect(activeRisk({})).toBe('high');
    } finally {
      noContract();
    }
  });

  it(`${VERIFY_RISK_ENV} env beats the contract`, () => {
    setActiveContractScope(contractWith('critical'));
    try {
      expect(activeRisk({ [VERIFY_RISK_ENV]: 'low' })).toBe('low');
    } finally {
      noContract();
    }
  });

  it('invalid env value is ignored (falls through to contract / medium)', () => {
    setActiveContractScope(contractWith('high'));
    try {
      expect(activeRisk({ [VERIFY_RISK_ENV]: 'Bogus' })).toBe('high');
    } finally {
      noContract();
    }
    expect(activeRisk({ [VERIFY_RISK_ENV]: 'bogus' })).toBe('medium');
  });
});

describe('pessimistic merge + divergence (critical)', () => {
  function review(verdict: VerifierReview['verdict'], provider?: string): VerifierReview {
    return {
      verdict,
      effectiveModel: { mode: 'inherit', ...(provider ? { provider } : {}) },
      usedLogprobs: false,
    };
  }

  it('any blocker/fail wins: rejected > unknown > confirmed', () => {
    const confirmed = review('confirmed', 'a');
    const unknown = review('unknown', 'b');
    const rejected = review('rejected', 'c');
    expect(mergeVerifierVerdicts([confirmed, rejected])).toBe(rejected);
    expect(mergeVerifierVerdicts([rejected, confirmed])).toBe(rejected);
    expect(mergeVerifierVerdicts([confirmed, unknown])).toBe(unknown);
    // exact tie keeps the EARLIEST review (deterministic behavior)
    expect(mergeVerifierVerdicts([confirmed, review('confirmed')])).toBe(confirmed);
  });

  it('divergence detected and recorded as a verifier-divergence evidence item', () => {
    const reviews = [review('rejected', 'anthropic'), review('confirmed', 'grok')];
    expect(verdictsDiverge(reviews)).toBe(true);
    const ev = divergenceFromReviews(reviews, [
      { family: 'anthropic', role: 'strongest' },
      { family: 'grok', role: 'second-opinion' },
    ]);
    expect(ev?.kind).toBe('verifier-divergence');
    expect(ev?.risk).toBe('critical');
    expect(ev?.divergent).toBe(true);
    expect(ev?.mergedVerdict).toBe('rejected');
    expect(ev?.reviews.map((r) => [r.family, r.role, r.verdict])).toEqual([
      ['anthropic', 'strongest', 'rejected'],
      ['grok', 'second-opinion', 'confirmed'],
    ]);
  });

  it('single-reviewer runs produce NO divergence entry (stable payloads)', () => {
    expect(divergenceFromReviews([review('rejected')])).toBeNull();
    expect(verdictsDiverge([review('confirmed'), review('confirmed')])).toBe(false);
  });
});

describe('blind-input property (PW §10, formalizing P0.6)', () => {
  const minimalGate = (results: StrictBuildGateEvaluation['results']) =>
    ({
      gate: { total: 0, passed: 0, failedChecks: [], unknownChecks: [], blocked: false },
      strict: true,
      evaluation: { verdict: 'PASS' },
      results,
      blocked: false,
      summary: 'test',
    }) as StrictBuildGateEvaluation;

  const noisyResults = [
    { criterionId: 'unit-tests', status: 'pass', detail: '58/58 green' },
    { criterionId: 'Typecheck', status: 'fail', detail: 'TS2304 x y z' },
    { criterionId: 'check-selection-contract', status: 'pass', detail: 'ignored' },
  ];

  /** Evidence-only key whitelist — anything else is a LEAK. */
  const ALLOWED = new Set(['task', 'summary', 'diffSummary', 'testOutputExcerpt', 'results']);

  it.each([
    ['task+diff+output', { task: 'ship feature X' }, true],
    ['minimal', {}, false],
  ])('%s: BlindReviewInput keys stay within the evidence whitelist', async (_n, extra, expectDiff) => {
    const blind = await buildBlindReviewInput(minimalGate(noisyResults), {
      ...extra,
      // Empty staged diff ⇒ degraded independently (diffSummary omitted).
      getDiff: async () =>
        expectDiff
          ? { diff: 'diff --git a/x b/x\n+m', empty: false, truncated: false }
          : { diff: '', empty: true, truncated: false },
    });
    for (const k of Object.keys(blind)) {
      expect(ALLOWED.has(k)).toBe(true);
    }
    // The synthetic summary exposes counts + verdict only; no messages/textBuffer
    // seam EXISTS on the input type (structural exclusion of narration), and the
    // git diff is included exactly when the provider reports a non-empty one.
    if (expectDiff) expect(blind.diffSummary).toContain('diff --git');
    else expect(blind.diffSummary).toBeUndefined();
    expect(blind.results?.map((r) => r.status)).toEqual(['pass', 'fail', 'pass']);
  });

  it('failed diff provider degrades WITHOUT ever leaking narration channels', async () => {
    const blind = await buildBlindReviewInput(minimalGate(noisyResults), {
      getDiff: async () => {
        throw new Error('git exploded');
      },
    });
    for (const k of Object.keys(blind)) expect(ALLOWED.has(k)).toBe(true);
    expect(blind.diffSummary).toBeUndefined();
  });
});

/**
 * t29 (§16): reputation-aware in-family preference. Family constraints are
 * NOT weakened — the injected records only reorder an ALREADY different-family
 * pool; below REPUTATION_MIN_SAMPLE (or with a null/absent source, or records
 * from another repo) the t21 heuristics stand byte-identically.
 */
describe('resolveVerifierRouting × reputation (t29)', () => {
  const REPO = 'zelari-code';

  function rep(
    model: string,
    provider: string,
    outcome: ReputationRecord['outcome'],
    over: Partial<ReputationRecord> = {},
  ): ReputationRecord {
    return {
      ts: 1_700_000_000_000,
      repo: REPO,
      model,
      provider,
      role: 'verify',
      language: null,
      outcome,
      firstPass: outcome === 'verified',
      repairCount: 0,
      costUsd: 1,
      latencyMs: 1000,
      ...over,
    };
  }

  const MEDIUM = (repo?: string) =>
    ({
      selectionMode: 'inherit',
      session: BUILDER,
      familyCandidates: CANDIDATES,
      env: {},
      ...(repo !== undefined ? { repo } : {}),
    }) as const;

  afterEach(() => setReputationSource(null));

  it('prefers the reputable in-family candidate over the cheap heuristic when sample ≥ threshold', () => {
    const records = [
      // anthropic pool = [claude-opus-4, claude-haiku-3]. Cheap heuristic would
      // pick haiku; reputation knows haiku always fails, opus always verifies.
      ...Array.from({ length: REPUTATION_MIN_SAMPLE }, () => rep('claude-haiku-3', 'anthropic', 'failed', { firstPass: false, repairCount: 1 })),
      ...Array.from({ length: REPUTATION_MIN_SAMPLE }, () => rep('claude-opus-4', 'anthropic', 'verified', { costUsd: 15 })),
    ];
    setReputationSource(records);
    const d = resolveVerifierRouting(BUILDER, 'medium', MEDIUM(REPO));
    expect(d.reviewers).toHaveLength(1);
    const r = d.reviewers[0]!;
    expect(r.identity).toEqual({ provider: 'anthropic', model: 'claude-opus-4' });
    expect(r.family).not.toBe('openai'); // family constraint intact
    expect(d.rationaleCode).toBe('cross-family-economical-reputation');
  });

  it('falls back to the plain heuristics when every bucket is below the sample threshold', () => {
    setReputationSource(
      Array.from({ length: REPUTATION_MIN_SAMPLE - 1 }, () => rep('claude-opus-4', 'anthropic', 'verified')),
    );
    const d = resolveVerifierRouting(BUILDER, 'medium', MEDIUM(REPO));
    expect(d.reviewers[0]!.identity.model).toBe('claude-haiku-3'); // cheap heuristic
    expect(d.rationaleCode).toBe('cross-family-economical');
  });

  it('is byte-identical to the t21 behavior with a null source', () => {
    const before = resolveVerifierRouting(BUILDER, 'medium', MEDIUM(REPO));
    setReputationSource(null);
    const after = resolveVerifierRouting(BUILDER, 'medium', MEDIUM(REPO));
    expect(after).toEqual(before);
    expect(after.reviewers[0]!.identity.model).toBe('claude-haiku-3');
  });

  it('ignores records bucketed under a different repo', () => {
    const other = Array.from({ length: REPUTATION_MIN_SAMPLE + 2 }, () =>
      rep('claude-opus-4', 'anthropic', 'verified', { repo: 'some-other-repo' }),
    );
    setReputationSource(other);
    const d = resolveVerifierRouting(BUILDER, 'medium', MEDIUM(REPO));
    expect(d.rationaleCode).toBe('cross-family-economical');
    expect(d.reviewers[0]!.identity.model).toBe('claude-haiku-3');
  });

  it('critical risk: reputation refines the primary-family pick without weakening independence', () => {
    const records = [
      ...Array.from({ length: REPUTATION_MIN_SAMPLE }, () => rep('claude-haiku-3', 'anthropic', 'verified', { costUsd: 0.2 })),
      ...Array.from({ length: REPUTATION_MIN_SAMPLE }, () => rep('claude-opus-4', 'anthropic', 'failed', { firstPass: false, costUsd: 15 })),
    ];
    setReputationSource(records);
    const d = resolveVerifierRouting(BUILDER, 'critical', MEDIUM(REPO));
    expect(d.rationaleCode).toBe('critical-dual-cross-family-pessimistic-merge');
    const [first, second] = d.reviewers;
    expect(first!.identity.model).toBe('claude-haiku-3'); // cheapest+verified wins the score
    expect(first!.family).not.toBe('openai');
    expect(second!.identity.model).not.toBe(BUILDER.model); // second opinion ≠ builder
    expect(new Set([first!.family, second!.family]).size).toBe(2); // two DIFFERENT families
  });
});
