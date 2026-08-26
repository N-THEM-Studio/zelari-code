/**
 * chooseOrchestration + `--mode auto` wiring tests (t12 / P1.1).
 *
 * The policy must be pure, deterministic, and fail-closed: anything that is
 * not clearly heavy work answers 'solo' (today's default surface). Parser
 * coverage lives here too because the allowlisted test location for this
 * slice is src/cli/orchestration/.
 */
import { describe, expect, it } from 'vitest';
import { chooseOrchestration, DEFAULT_MAX_SOLO_CHARS } from './policy.js';
import { parseHeadlessFlags } from '../headless.js';

describe('chooseOrchestration — solo tiers (light/short/unsure)', () => {
  it('questions stay solo regardless of domain nouns', () => {
    expect(chooseOrchestration('What does parseMode do?')).toEqual({
      surface: 'solo',
      reason: 'question-shaped task',
    });
    expect(chooseOrchestration('Where is resolveHeadlessKey defined')).toEqual({
      surface: 'solo',
      reason: 'question-shaped task',
    });
  });

  it('explain/describe requests stay solo', () => {
    expect(chooseOrchestration('Explain the kraken completion gate')).toEqual({
      surface: 'solo',
      reason: 'explanation request',
    });
    expect(chooseOrchestration('summarize this diff')).toEqual({
      surface: 'solo',
      reason: 'explanation request',
    });
  });

  it('read-only requests stay solo', () => {
    expect(chooseOrchestration('find all callers of emitEvent in src/cli')).toEqual({
      surface: 'solo',
      reason: 'read-only request',
    });
    expect(chooseOrchestration('list files in src/cli/orchestration')).toEqual({
      surface: 'solo',
      reason: 'read-only request',
    });
  });

  it('short neutral prompts are small-task solo', () => {
    expect(chooseOrchestration('hi')).toEqual({
      surface: 'solo',
      reason: 'small task, no heavy signals',
    });
  });

  it('empty prompt fails closed', () => {
    expect(chooseOrchestration('')).toEqual({ surface: 'solo', reason: 'fail-closed default' });
    expect(chooseOrchestration('   \n\t ')).toEqual({
      surface: 'solo',
      reason: 'fail-closed default',
    });
  });

  it('long neutral prompts fail closed instead of escalating', () => {
    const longNeutral = 'grey obsidian drift chart beats steady under quiet harbor winds'.repeat(
      12,
    );
    expect(longNeutral.length).toBeGreaterThan(DEFAULT_MAX_SOLO_CHARS);
    expect(chooseOrchestration(longNeutral)).toEqual({
      surface: 'solo',
      reason: 'fail-closed default',
    });
  });

  it('maxSoloChars override moves the size boundary', () => {
    const text = 'steady tide over the pebble shore';
    expect(text.length).toBeLessThanOrEqual(DEFAULT_MAX_SOLO_CHARS);
    expect(chooseOrchestration(text).reason).toBe('small task, no heavy signals');
    expect(chooseOrchestration(text, { maxSoloChars: 5 }).surface).toBe('solo');
    expect(chooseOrchestration(text, { maxSoloChars: 5 }).reason).toBe('fail-closed default');
  });
});

describe('chooseOrchestration — kraken tiers (heavy intent)', () => {
  it('implementation verbs escalate', () => {
    expect(chooseOrchestration('Implement retry backoff in the provider client')).toEqual({
      surface: 'kraken',
      reason: 'implementation signal',
    });
    expect(chooseOrchestration('Refactor sessionSpine into two focused modules')).toEqual({
      surface: 'kraken',
      reason: 'refactor signal',
    });
    expect(chooseOrchestration('Migrate the memory backend to the sqlite worker')).toEqual({
      surface: 'kraken',
      reason: 'migration signal',
    });
  });

  it('new capabilities and test-writing escalate', () => {
    expect(
      chooseOrchestration('Add an export endpoint and create a stats service for headless runs'),
    ).toEqual({ surface: 'kraken', reason: 'new-capability signal' });
    expect(chooseOrchestration('Write unit tests for budgetRuntime and verifierLifecycle')).toEqual(
      { surface: 'kraken', reason: 'test-writing signal' },
    );
  });

  it('counted artifacts and cross-cutting scope escalate', () => {
    expect(chooseOrchestration('Split the helpers into 4 files under src/utils')).toEqual({
      surface: 'kraken',
      reason: 'multi-artifact count',
    });
    expect(chooseOrchestration('Align error handling across both packages, no rush')).toEqual({
      surface: 'kraken',
      reason: 'cross-cutting scope',
    });
  });

  it('heavy intent outranks question phrasing', () => {
    expect(
      chooseOrchestration('Can you quickly explain how to migrate the storage layer?'),
    ).toEqual({ surface: 'kraken', reason: 'migration signal' });
  });
});

describe('chooseOrchestration — purity contract', () => {
  it('is deterministic: same input, same verdict', () => {
    const task = 'Tidy up budgetRuntime comments';
    expect(chooseOrchestration(task)).toEqual(chooseOrchestration(task));
  });

  it('never mutates its inputs and tolerates non-string coercion', () => {
    const task = 'Fix the typo in README';
    const snapshot = task;
    chooseOrchestration(task);
    expect(task).toBe(snapshot);
    expect(chooseOrchestration(undefined as unknown as string)).toEqual({
      surface: 'solo',
      reason: 'fail-closed default',
    });
  });
});

describe('--mode auto parsing (opt-in)', () => {
  it('accepts --mode auto and keeps execution on the ordinary default', () => {
    const res = parseHeadlessFlags(['--headless', '--task', 'classify me please', '--mode', 'auto']);
    expect(res.error).toBeUndefined();
    expect(res.options?.orchestrationAuto).toBe(true);
    // Resolved at dispatch time; parsing pins the historical default so a
    // missing resolver can never change behavior.
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
