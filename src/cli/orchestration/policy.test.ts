/**
 * OrchestrationDecision v2 tests (t12 / P1.1 → t23 / P1.E × PW §9).
 *
 * The policy must stay pure, deterministic and fail-closed. V2 adds the
 * fine-grained strategy ladder, `estimatedLatencyMs`, contract/seam inputs,
 * failure escalation and the goldens:
 *   - small task ⇒ lead-only AND delegation forbids tentacles (NO
 *     over-orchestration);
 *   - complex task ⇒ graph/parallel-build AND tentacles preferred;
 *   - council ONLY with its design-conflict trigger;
 *   - same inputs ⇒ same decision (determinism permutations).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chooseOrchestration,
  DEFAULT_MAX_SOLO_CHARS,
  PARALLEL_SCOPE_PATHS,
} from './policy.js';
import { ESTIMATED_LATENCY_MS, ORCHESTRATION_STRATEGIES, STRATEGY_RANK, strategySurface } from './signals.js';
import {
  krakenDelegationPlaybook,
  resolveDelegationPolicyForRun,
} from '../kraken/delegationPolicy.js';
import { parseHeadlessFlags } from '../headless.js';

// Hermeticity: this developer shell really exports ZELARI_KRAKEN_DELEGATION
// (=prefer). Decision/delegation GOLDENS must observe the pure strategy
// mapping, so the env override is neutralized for the whole suite.
const savedDelegationEnv = process.env['ZELARI_KRAKEN_DELEGATION'];
beforeEach(() => {
  delete process.env['ZELARI_KRAKEN_DELEGATION'];
});
afterAll(() => {
  if (savedDelegationEnv !== undefined) process.env['ZELARI_KRAKEN_DELEGATION'] = savedDelegationEnv;
});

describe('chooseOrchestration — light tiers map onto solo surface', () => {
  it('questions stay lead-only regardless of domain nouns', () => {
    const d = chooseOrchestration('What does parseMode do?');
    expect(d.strategy).toBe('lead-only');
    expect(d.surface).toBe('solo');
    expect(d.rationaleCode).toBe('question_shaped_task');
    expect(typeof d.confidence).toBe('number');
  });

  it('read-only requests are explore work (discovery, still single harness)', () => {
    expect(chooseOrchestration('find all callers of emitEvent in src/cli')).toMatchObject({
      strategy: 'explore',
      rationaleCode: 'read_only_request',
    });
    // "where is ..." reads like a search before it reads like a question.
    expect(chooseOrchestration('Where is resolveHeadlessKey defined')).toMatchObject({
      strategy: 'explore',
      rationaleCode: 'read_only_request',
    });
  });

  it('explain requests stay lead-only', () => {
    expect(chooseOrchestration('Explain the kraken completion gate')).toMatchObject({
      strategy: 'lead-only',
      rationaleCode: 'explanation_request',
    });
  });

  it('short neutral prompts are small-task lead-only (no over-orchestration)', () => {
    expect(chooseOrchestration('hi')).toEqual({
      strategy: 'lead-only',
      surface: 'solo',
      confidence: expect.any(Number),
      rationaleCode: 'small_task_no_heavy_signals',
      reason: 'small task, no heavy signals',
      estimatedLatencyMs: ESTIMATED_LATENCY_MS['lead-only'],
    });
  });

  it('empty prompt fails closed (stable low-confidence answer)', () => {
    expect(chooseOrchestration('')).toMatchObject({ strategy: 'lead-only', rationaleCode: 'fail_closed_empty' });
    expect(chooseOrchestration('   \n\t ').confidence).toBeLessThan(0.5);
  });

  it('long neutral prompts fail closed instead of escalating', () => {
    const longNeutral = 'grey obsidian drift chart beats steady under quiet harbor winds'.repeat(12);
    expect(longNeutral.length).toBeGreaterThan(DEFAULT_MAX_SOLO_CHARS);
    expect(chooseOrchestration(longNeutral)).toMatchObject({
      strategy: 'lead-only',
      surface: 'solo',
      rationaleCode: 'fail_closed_default',
    });
  });

  it('maxSoloChars override moves the size boundary', () => {
    const text = 'steady tide over the pebble shore';
    expect(text.length).toBeLessThanOrEqual(DEFAULT_MAX_SOLO_CHARS);
    expect(chooseOrchestration(text).rationaleCode).toBe('small_task_no_heavy_signals');
    expect(chooseOrchestration(text, { maxSoloChars: 5 }).surface).toBe('solo');
    expect(chooseOrchestration(text, { maxSoloChars: 5 }).rationaleCode).toBe('fail_closed_default');
  });

  it('a large repo alone NEVER escalates (weak signal: only upgrades small-task classification quality)', () => {
    const tidy = 'tidy up the retry log lines';
    expect(chooseOrchestration(tidy).rationaleCode).toBe('small_task_no_heavy_signals');
    expect(chooseOrchestration(tidy, { repoSize: 9000 }).rationaleCode).toBe('fail_closed_default');
    expect(chooseOrchestration(tidy, { repoSize: 9000 }).strategy).toBe('lead-only');
  });
});

describe('chooseOrchestration — build tiers (heavy intent)', () => {
  it('implementation verbs give lead+verify (implement then verify)', () => {
    expect(chooseOrchestration('Implement retry backoff in the provider client')).toMatchObject({
      strategy: 'lead+verify',
      surface: 'kraken',
      rationaleCode: 'implementation_signal',
    });
    expect(chooseOrchestration('Refactor sessionSpine into two focused modules')).toMatchObject({
      strategy: 'lead+verify',
      rationaleCode: 'refactor_signal',
    });
    expect(chooseOrchestration('Migrate the memory backend to the sqlite worker')).toMatchObject({
      strategy: 'lead+verify',
      rationaleCode: 'migration_signal',
    });
  });

  it('new capabilities and test-writing escalate to lead+verify', () => {
    expect(
      chooseOrchestration('Add an export endpoint and create a stats service for headless runs'),
    ).toMatchObject({ strategy: 'lead+verify', rationaleCode: 'new_capability_signal' });
    expect(chooseOrchestration('Write unit tests for budgetRuntime and verifierLifecycle')).toMatchObject({
      strategy: 'lead+verify',
      rationaleCode: 'test_writing_signal',
    });
  });

  it('counted artifacts mean disjoint targets ⇒ parallel-build', () => {
    expect(chooseOrchestration('Split the helpers into 4 files under src/utils')).toMatchObject({
      strategy: 'parallel-build',
      surface: 'kraken',
      rationaleCode: 'multi_artifact_count',
    });
  });

  it('a wide contract scope implies parallel slices', () => {
    const d = chooseOrchestration('align naming conventions everywhere possible', {
      scopePathsCount: PARALLEL_SCOPE_PATHS,
    });
    expect(d).toMatchObject({ strategy: 'parallel-build', rationaleCode: 'multi_path_scope' });
  });

  it('cross-cutting scope escalates to graph', () => {
    expect(chooseOrchestration('Align error handling across both packages, no rush')).toMatchObject({
      strategy: 'graph',
      surface: 'kraken',
      rationaleCode: 'cross_cutting_scope',
    });
  });

  it('declared contract risk high/critical escalates straight to graph', () => {
    expect(chooseOrchestration('Implement retry backoff', { risk: 'high' })).toMatchObject({
      strategy: 'graph',
      rationaleCode: 'contract_high_risk',
    });
    expect(chooseOrchestration('Add a stats endpoint', { risk: 'critical' }).strategy).toBe('graph');
  });

  it('heavy intent outranks question phrasing (and still lands verify-worthy)', () => {
    expect(chooseOrchestration('Can you quickly explain how to migrate the storage layer?')).toMatchObject({
      strategy: 'lead+verify',
      rationaleCode: 'migration_signal',
    });
  });
});

describe('council — exactly ONE trigger (design wording ∧ ambiguity marker)', () => {
  it('fires only when BOTH halves of the trigger are present', () => {
    expect(chooseOrchestration('Design the new cache approach — requirements conflict and feel ambiguous')).toEqual({
      strategy: 'council',
      surface: 'council',
      confidence: expect.any(Number),
      rationaleCode: 'design_conflict_signal',
      reason: 'design + ambiguity conflict',
      estimatedLatencyMs: ESTIMATED_LATENCY_MS.council,
    });
    expect(chooseOrchestration('Design the new cache approach').strategy).not.toBe('council');
    expect(chooseOrchestration('the ambiguous conflicting unclear thing everywhere').strategy).not.toBe('council');
  });

  it('plain build corpus never invents a council', () => {
    for (const t of [
      'Implement retry backoff',
      'Migrate the storage layer',
      'Split into 4 files under src/utils',
      'Across all packages align errors',
      'What does parseMode do?',
      'find callers of emitEvent',
      'hi',
    ]) {
      expect(chooseOrchestration(t).strategy, t).not.toBe('council');
    }
  });
});

describe('previousFailures escalation (spine input, monotonic upgrade only)', () => {
  it('one failure lifts lead-only strategies to lead+verify', () => {
    expect(
      chooseOrchestration('Explain nothing useful here', { previousFailures: 1 }),
    ).toMatchObject({ strategy: 'lead+verify', rationaleCode: 'prior_failure_verification_bump' });
  });

  it('two or more failures force graph unless already council', () => {
    expect(chooseOrchestration('list files somewhere nice', { previousFailures: 2 })).toMatchObject({
      strategy: 'graph',
      rationaleCode: 'repeated_verification_failures',
    });
  });

  it('never downgrades heavier verdicts nor touches a council decision', () => {
    const graphFirst = chooseOrchestration('Across all packages align errors', { previousFailures: 1 });
    expect(graphFirst.rationaleCode).toBe('cross_cutting_scope'); // unchanged
    const council = chooseOrchestration(
      'Design the approach; trade-offs are unclear',
      { previousFailures: 3 },
    );
    expect(council.strategy).toBe('council');
  });
});

describe('PW §9 goldens — mode/delegation consequences', () => {
  it('small task ⇒ lead-only strategy AND a delegation module that spawns NO tentacles', () => {
    const d = chooseOrchestration('fix the typo in README intro paragraph');
    expect(d.strategy).toBe('lead-only');
    expect(resolveDelegationPolicyForRun(d.strategy)).toBe('lead-only');
    const mods = krakenDelegationPlaybook(true, resolveDelegationPolicyForRun(d.strategy));
    expect(mods).toHaveLength(1); // REAL policy replaces the old automatic no-op
    expect(mods[0].content).toMatch(/Do \*\*not\*\* spawn/);
    expect(mods[0].content).toMatch(/Lead only/i);
  });

  it('complex task ⇒ tentacles-preferred policy (parallel-build and graph alike)', () => {
    for (const d of [
      chooseOrchestration('Split the helpers into 4 files under src/utils'),
      chooseOrchestration('Align error handling across all packages'),
    ]) {
      expect(['parallel-build', 'graph']).toContain(d.strategy);
      expect(krakenDelegationPlaybook(true, resolveDelegationPolicyForRun(d.strategy))).toHaveLength(1);
      expect(krakenDelegationPlaybook(true, resolveDelegationPolicyForRun(d.strategy))[0].content).toMatch(
        /prefer tentacles/i,
      );
    }
  });

  it('council routes to the council surface (host forces the lite tier)', () => {
    const d = chooseOrchestration('Design proposal — needs are contradictory, pick trade-offs');
    expect(strategySurface(d.strategy)).toBe('council');
    expect(resolveDelegationPolicyForRun(d.strategy)).toBe('automatic'); // n/a there
  });
});

describe('estimatedLatencyMs (heuristic ms units, monotonic in complexity)', () => {
  it('grows monotonically along the declared strategy ladder', () => {
    const ranked = [...ORCHESTRATION_STRATEGIES].sort((a, b) => STRATEGY_RANK[a] - STRATEGY_RANK[b]);
    let prev = -1;
    for (const s of ranked) {
      expect(ESTIMATED_LATENCY_MS[s]).toBeGreaterThanOrEqual(prev);
      prev = ESTIMATED_LATENCY_MS[s];
    }
  });

  it('every decision carries its strategy constant', () => {
    expect(chooseOrchestration('Implement x').estimatedLatencyMs).toBe(ESTIMATED_LATENCY_MS['lead+verify']);
    expect(chooseOrchestration('Align across packages').estimatedLatencyMs).toBe(ESTIMATED_LATENCY_MS.graph);
  });
});

describe('decision replay invariance — same inputs ⇒ same decision', () => {
  const permutations: Array<[string, Parameters<typeof chooseOrchestration>[1]]> = [
    ['Implement retry backoff', {}],
    ['What does parseMode do?', {}],
    ['Split into 4 files under src/utils', { risk: 'medium', repoSize: 120 }],
    ['Explain the gate', { previousFailures: 1, risk: 'low' }],
    ['Design the thing, unclear', { risk: 'critical', repoSize: 42, previousFailures: 3 }],
    ['find callers please', { scopePathsCount: 5 }],
    ['', {}],
    ['grey obsidian winds '.repeat(40), { repoSize: 99999 }],
  ];

  it.each(permutations.map((p) => [p[0].slice(0, 32), p] as const))(
    'deterministic for %j',
    (_label, [task, opts]) => {
      expect(chooseOrchestration(task, opts)).toEqual(chooseOrchestration(task, opts));
    },
  );

  it('never mutates its inputs and tolerates non-string coercion', () => {
    const task = 'Fix the typo in README';
    chooseOrchestration(task);
    expect(task).toBe(task);
    expect(chooseOrchestration(undefined as unknown as string)).toMatchObject({
      strategy: 'lead-only',
      rationaleCode: 'fail_closed_empty',
    });
  });
});

describe('--mode auto parsing (opt-in, unchanged since t12)', () => {
  it('accepts --mode auto and keeps execution pinned until dispatch', () => {
    const res = parseHeadlessFlags(['--headless', '--task', 'classify me please', '--mode', 'auto']);
    expect(res.error).toBeUndefined();
    expect(res.options?.orchestrationAuto).toBe(true);
    expect(res.options?.mode).toBe('kraken');
    expect(res.options?.useCouncil).toBe(false);
  });

  it('is case-insensitive', () => {
    const res = parseHeadlessFlags(['--headless', '--task', 't', '--mode', 'AUTO']);
    expect(res.options?.orchestrationAuto).toBe(true);
  });

  it('leaves plain runs byte-identical: no orchestrationAuto field', () => {
    const res = parseHeadlessFlags(['--headless', '--task', 'hello world']);
    expect(res.options?.orchestrationAuto).toBeUndefined();
    expect(res.options?.orchestrationDecision).toBeUndefined();
    expect(res.options?.mode).toBe('kraken');
  });

  it('unknown modes still fail with the updated hint', () => {
    const res = parseHeadlessFlags(['--headless', '--task', 't', '--mode', 'banana']);
    expect(res.options).toBeNull();
    expect(res.error).toContain("'kraken', 'council', 'zelari', or 'auto'");
  });

  it('--council still conflicts with an explicit --mode auto', () => {
    const res = parseHeadlessFlags(['--headless', '--task', 't', '--council', '--mode', 'auto']);
    expect(res.options).toBeNull();
    expect(res.error).toContain('conflicts');
  });
});
