/**
 * cli-councilToolEmission.test.ts — post-condition check + retry decision on
 * member tool calls.
 *
 * Background: Bug C + Fix e987284 anchor role prompts to workspace tools
 * (createDocument, createTask, etc.) but the model can still skip them in
 * a single turn — leaving the deliverable incomplete (Minosse's risks.md
 * missing, Lucifero's synthesis.md missing, Nettuno's tasks missing).
 *
 * This test pins:
 *   1. The post-condition check (checkMemberToolEmissions) — exports ok/missing.
 *   2. The retry decision (shouldRetryMember) — caps attempts per member.
 *   3. The retry prompt builder (buildRetryPrompt) — names missing tools.
 *
 * The retry logic is invoked by councilApi.ts AFTER the post-condition check
 * fails, BEFORE the council run yields the next member. It runs ONE additional
 * AgentHarness turn scoped to ONLY the missing tools with a one-line prompt
 * forcing the model to emit them. Max 1 retry per member.
 */
import { describe, it, expect } from 'vitest';
import {
  checkMemberToolEmissions,
  shouldRetryMember,
  buildRetryPrompt,
} from '@zelari/core/council';

describe('checkMemberToolEmissions — pure helper', () => {
  it('returns ok=true when all required tools are emitted with min count', () => {
    const result = checkMemberToolEmissions(
      'minos',
      ['createDocument', 'createDocument', 'searchDocuments'],
      [{ name: 'createDocument', min: 1 }],
    );
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('returns ok=false and lists missing tools when required tool is absent', () => {
    const result = checkMemberToolEmissions(
      'minos',
      ['searchDocuments', 'searchDocuments'],
      [{ name: 'createDocument', min: 1 }],
    );
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['createDocument (got 0, need >= 1)']);
  });

  it('returns ok=false when tool emitted below the minimum count', () => {
    const result = checkMemberToolEmissions(
      'geryon',
      ['createDocument'], // only 1 of 3 required
      [{ name: 'createDocument', min: 3 }],
    );
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['createDocument (got 1, need >= 3)']);
  });

  it('handles multiple required tools at once', () => {
    const result = checkMemberToolEmissions(
      'nettun',
      ['createPhase', 'createPhase', 'createPhase', 'createPhase', 'createTask'],
      [
        { name: 'createPhase', min: 3 },
        { name: 'createTask', min: 3 },
        { name: 'createMilestone', min: 1 },
      ],
    );
    expect(result.ok).toBe(false);
    // createPhase: 4 >= 3 ✓
    // createTask: 1 < 3 ✗
    // createMilestone: 0 < 1 ✗
    expect(result.missing).toEqual([
      'createTask (got 1, need >= 3)',
      'createMilestone (got 0, need >= 1)',
    ]);
  });

  it('treats empty requirements as vacuously ok', () => {
    const result = checkMemberToolEmissions('charont', [], []);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });
});

describe('shouldRetryMember — retry budget', () => {
  it('returns true when missing tools exist and attempts < 1', () => {
    expect(shouldRetryMember(['createDocument'], 0)).toBe(true);
  });

  it('returns false when no tools are missing', () => {
    expect(shouldRetryMember([], 0)).toBe(false);
  });

  it('returns false when attempts have already hit the cap of 1', () => {
    // Max 1 retry per member — second call to retry is forbidden.
    expect(shouldRetryMember(['createDocument'], 1)).toBe(false);
  });

  it('returns false when attempts exceed the cap', () => {
    expect(shouldRetryMember(['createTask', 'createMilestone'], 5)).toBe(false);
  });
});

describe('buildRetryPrompt — one-line forced continuation', () => {
  it('lists every missing tool by name', () => {
    const prompt = buildRetryPrompt(['createDocument']);
    expect(prompt).toContain('createDocument');
    // The prompt MUST be a single actionable line — no narration, no
    // apologies, no 'please'. The model has a strong tendency to
    // produce prose when given an open prompt, so we constrain it.
    expect(prompt.split('\n').length).toBeLessThanOrEqual(2);
  });

  it('joins multiple missing tools with commas', () => {
    const prompt = buildRetryPrompt(['createTask', 'createMilestone']);
    expect(prompt).toContain('createTask');
    expect(prompt).toContain('createMilestone');
    expect(prompt).toMatch(/createTask.*createMilestone|createMilestone.*createTask/);
  });

  it('contains a directive verb (call/emit) to force action', () => {
    const prompt = buildRetryPrompt(['createDocument']);
    expect(prompt.toLowerCase()).toMatch(/\b(call|emit|invoke)\b/);
  });
});

/**
 * v0.7.8: the plan contract is now satisfiable with a SINGLE createPlan
 * batch call, so Nettuno's forced retry has the same 1-call budget that
 * already works for Minosse/Lucifero. NON_RETRY_AGENTS is therefore
 * empty — it stays exported as the opt-out mechanism for future members.
 */
describe('v0.7.8 — retry re-enabled for every member (NON_RETRY_AGENTS empty)', () => {
  it('NON_RETRY_AGENTS no longer contains nettun (createPlan makes retry a 1-call budget)', async () => {
    const { NON_RETRY_AGENTS } = await import('@zelari/core/council');
    expect(NON_RETRY_AGENTS.has('nettun')).toBe(false);
  });

  it('NON_RETRY_AGENTS is empty', async () => {
    const { NON_RETRY_AGENTS } = await import('@zelari/core/council');
    expect(NON_RETRY_AGENTS.size).toBe(0);
  });
});

/**
 * v0.7.8 — OR-of-sets requirements. Nettuno satisfies its design-phase
 * contract EITHER with one createPlan batch call OR with the legacy
 * itemized trio (createPhase/createTask/createMilestone). When neither
 * is met, the missing list points at the PREFERRED set (createPlan) so
 * the forced retry advertises one tool with a 1-call budget.
 */
describe('checkMemberToolEmissionSets — OR-of-sets contract', () => {
  it('nettun is satisfied by ONE createPlan call (preferred set)', async () => {
    const { checkMemberToolEmissionSets, DESIGN_PHASE_REQUIREMENT_SETS } =
      await import('@zelari/core/council');
    const result = checkMemberToolEmissionSets(
      'nettun',
      ['createPlan'],
      DESIGN_PHASE_REQUIREMENT_SETS['nettun']!,
    );
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('nettun is satisfied by the legacy itemized trio (no retry for strong models)', async () => {
    const { checkMemberToolEmissionSets, DESIGN_PHASE_REQUIREMENT_SETS } =
      await import('@zelari/core/council');
    const emitted = [
      'createPhase', 'createPhase', 'createPhase', 'createPhase',
      'createTask', 'createTask', 'createTask', 'createTask', 'createTask', 'createTask',
      'createMilestone',
    ];
    const result = checkMemberToolEmissionSets(
      'nettun',
      emitted,
      DESIGN_PHASE_REQUIREMENT_SETS['nettun']!,
    );
    expect(result.ok).toBe(true);
  });

  it('when neither set is met, missing reflects the preferred set (createPlan)', async () => {
    const { checkMemberToolEmissionSets, DESIGN_PHASE_REQUIREMENT_SETS } =
      await import('@zelari/core/council');
    const result = checkMemberToolEmissionSets(
      'nettun',
      ['createPhase', 'createTask'], // partial itemized run — neither set satisfied
      DESIGN_PHASE_REQUIREMENT_SETS['nettun']!,
    );
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['createPlan (got 0, need >= 1)']);
  });

  it('DESIGN_PHASE_REQUIREMENTS (flat map) is the preferred set — createPlan min 1 for nettun', async () => {
    const { DESIGN_PHASE_REQUIREMENTS } = await import('@zelari/core/council');
    expect(DESIGN_PHASE_REQUIREMENTS['nettun']).toEqual([{ name: 'createPlan', min: 1 }]);
    // Retry budget for nettun is now 1 call — the shape that composer-2.5
    // already satisfies for Minosse and Lucifero.
    const budget = DESIGN_PHASE_REQUIREMENTS['nettun']!.reduce((s, r) => s + r.min, 0);
    expect(budget).toBe(1);
  });

  it('single-set members (minos, lucifer, geryon) behave exactly as before', async () => {
    const { checkMemberToolEmissionSets, DESIGN_PHASE_REQUIREMENT_SETS } =
      await import('@zelari/core/council');
    expect(
      checkMemberToolEmissionSets('minos', ['createDocument'], DESIGN_PHASE_REQUIREMENT_SETS['minos']!).ok,
    ).toBe(true);
    expect(
      checkMemberToolEmissionSets('lucifer', [], DESIGN_PHASE_REQUIREMENT_SETS['lucifer']!).ok,
    ).toBe(false);
    expect(
      checkMemberToolEmissionSets('geryon', ['createDocument', 'createDocument'], DESIGN_PHASE_REQUIREMENT_SETS['geryon']!).missing,
    ).toEqual(['createDocument (got 2, need >= 3)']);
  });
});