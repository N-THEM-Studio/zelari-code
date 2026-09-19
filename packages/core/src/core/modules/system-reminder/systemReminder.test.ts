/**
 * systemReminder.test.ts — pure reminder builder: cadence, todo payload,
 * budget threshold, kill-switch, purity.
 */
import { describe, expect, it } from 'vitest';
import {
  BUDGET_WARN_PCT,
  DEFAULT_CADENCE_TURNS,
  MAX_REMINDER_TODOS,
  SYSTEM_REMINDER_MARKER,
  buildSystemReminder,
  systemReminderEnabled,
} from './systemReminder.js';

const NO_ENV: Record<string, string | undefined> = {};
const OFF_ENV: Record<string, string | undefined> = { ZELARI_SYSTEM_REMINDER: '0' };

/** Minimal valid input; every test overrides only what it exercises. */
function input(overrides: Partial<Parameters<typeof buildSystemReminder>[0]> = {}) {
  return {
    pendingTodos: ['finish the runaway-guard wiring'],
    turnsSinceLastReminder: DEFAULT_CADENCE_TURNS,
    ...overrides,
  };
}

describe('buildSystemReminder — cadence', () => {
  it('stays silent until the cadence is reached', () => {
    expect(DEFAULT_CADENCE_TURNS).toBe(5);
    expect(buildSystemReminder(input({ turnsSinceLastReminder: 4 }), NO_ENV)).toBeNull();
    const due = buildSystemReminder(input({ turnsSinceLastReminder: 5 }), NO_ENV);
    expect(due).toContain(SYSTEM_REMINDER_MARKER);
    expect(due).toContain('finish the runaway-guard wiring');
  });

  it('keeps firing once past the cadence (host resets the counter)', () => {
    expect(buildSystemReminder(input({ turnsSinceLastReminder: 9 }), NO_ENV)).not.toBeNull();
  });

  it('honors a custom cadence', () => {
    const every2 = input({ cadenceTurns: 2, turnsSinceLastReminder: 1 });
    expect(buildSystemReminder(every2, NO_ENV)).toBeNull();
    expect(
      buildSystemReminder({ ...every2, turnsSinceLastReminder: 2 }, NO_ENV),
    ).not.toBeNull();
  });

  it('falls back to the default cadence for a non-positive/NaN value', () => {
    expect(buildSystemReminder(input({ cadenceTurns: 0, turnsSinceLastReminder: 1 }), NO_ENV)).toBeNull();
    expect(
      buildSystemReminder(
        input({ cadenceTurns: Number.NaN, turnsSinceLastReminder: 1 }),
        NO_ENV,
      ),
    ).toBeNull();
  });
});

describe('buildSystemReminder — payload', () => {
  it('is null when there is no pending todo', () => {
    expect(buildSystemReminder(input({ pendingTodos: [] }), NO_ENV)).toBeNull();
    expect(buildSystemReminder(input({ pendingTodos: ['   ', ''] }), NO_ENV)).toBeNull();
  });

  it('renders at most 5 todo lines and summarizes the rest', () => {
    const todos = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'];
    const text = buildSystemReminder(input({ pendingTodos: todos }), NO_ENV)!;
    expect(MAX_REMINDER_TODOS).toBe(5);
    expect(text.split('\n').filter((line) => line.startsWith('- t'))).toHaveLength(5);
    expect(text).toContain('+2 more');
    expect(text).not.toContain('t6');
  });

  it('collapses whitespace and keeps determinism', () => {
    const messy = input({ pendingTodos: ['  fix   the\n\n parser  '] });
    const first = buildSystemReminder(messy, NO_ENV);
    expect(first).toContain('- fix the parser');
    expect(buildSystemReminder(messy, NO_ENV)).toBe(first);
  });

  it('includes the budget line only below 50% remaining', () => {
    expect(BUDGET_WARN_PCT).toBe(50);
    const high = buildSystemReminder(input({ budgetRemainingPct: 50 }), NO_ENV)!;
    expect(high).not.toContain('Budget remaining');
    const low = buildSystemReminder(input({ budgetRemainingPct: 12.4 }), NO_ENV)!;
    expect(low).toContain('Budget remaining: 12%');
    const absent = buildSystemReminder(input(), NO_ENV)!;
    expect(absent).not.toContain('Budget remaining');
  });

  it('clamps a negative percentage to 0%', () => {
    const text = buildSystemReminder(input({ budgetRemainingPct: -3 }), NO_ENV)!;
    expect(text).toContain('Budget remaining: 0%');
  });
});

describe('buildSystemReminder — kill-switch', () => {
  it('ZELARI_SYSTEM_REMINDER=0 always yields null', () => {
    expect(systemReminderEnabled(OFF_ENV)).toBe(false);
    expect(systemReminderEnabled(NO_ENV)).toBe(true);
    expect(buildSystemReminder(input({ budgetRemainingPct: 1 }), OFF_ENV)).toBeNull();
  });

  it('reads the real environment variable and restores it', () => {
    const previous = process.env.ZELARI_SYSTEM_REMINDER;
    process.env.ZELARI_SYSTEM_REMINDER = '0';
    try {
      expect(buildSystemReminder(input())).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.ZELARI_SYSTEM_REMINDER;
      else process.env.ZELARI_SYSTEM_REMINDER = previous;
    }
    expect(systemReminderEnabled()).toBe(true);
  });
});
