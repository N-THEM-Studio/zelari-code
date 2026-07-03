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
 * v0.7.7 Opzione B: Nettuno's role prompt requires 12 createTask +
 * 1 createMilestone. composer-2.5 reliably refuses to emit them
 * even with aggressive retry (Pass 3 confirmed: 12 calls emitted
 * but only 7 persisted before the 240s timeout). Forcing more
 * retries wastes budget. Instead, the specialist loop SKIPS the
 * retry for Nettuno and lets the deterministic post-processor
 * (complete-design.mjs) fill in the gaps from a template.
 */
describe('Opzione B — Nettuno retry skip', () => {
  it('NON_RETRY_AGENTS set contains nettun', async () => {
    const { NON_RETRY_AGENTS } = await import('@zelari/core/council');
    expect(NON_RETRY_AGENTS.has('nettun')).toBe(true);
  });

  it('NON_RETRY_AGENTS set does NOT contain other specialists (gerion, plutone, caronte)', async () => {
    const { NON_RETRY_AGENTS } = await import('@zelari/core/council');
    expect(NON_RETRY_AGENTS.has('gerion')).toBe(false);
    expect(NON_RETRY_AGENTS.has('pluton')).toBe(false);
    expect(NON_RETRY_AGENTS.has('caronte')).toBe(false);
  });

  it('NON_RETRY_AGENTS set does NOT contain chairman/oracle (their retry stays)', async () => {
    const { NON_RETRY_AGENTS } = await import('@zelari/core/council');
    expect(NON_RETRY_AGENTS.has('lucifer')).toBe(false);
    expect(NON_RETRY_AGENTS.has('minos')).toBe(false);
  });
});