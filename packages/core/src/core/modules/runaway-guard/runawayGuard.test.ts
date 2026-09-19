/**
 * runawayGuard.test.ts — anti-loop policies: identical-repetition warn,
 * no-progress stall abort, kill-switch, fail-soft degradation.
 *
 * Every guard instance is built with an EXPLICIT env object (`{}`) so the
 * ambient developer/CI environment can never decide the outcome; the one test
 * that exercises the real variable sets and restores `process.env` itself.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_IDENTICAL_THRESHOLD,
  DEFAULT_STALL_TURNS,
  RunawayGuard,
  guardSafely,
  runawayGuardEnabled,
  toolCallHash,
} from './runawayGuard.js';

const NO_ENV: Record<string, string | undefined> = {};
const OFF_ENV: Record<string, string | undefined> = { ZELARI_RUNAWAY_GUARD: '0' };

/** One "unproductive" turn: the same call with the same result, again. */
const SAME_TURN = { callKeys: ['read_file:abc'], results: ['same content'] };

describe('RunawayGuard — identical repetition (warn)', () => {
  it('allows the first two identical calls and warns on the third', () => {
    const guard = new RunawayGuard({}, NO_ENV);
    expect(DEFAULT_IDENTICAL_THRESHOLD).toBe(3);
    expect(guard.checkToolCall('read_file', { path: 'a.ts' }).policy).toBe('allow');
    expect(guard.checkToolCall('read_file', { path: 'a.ts' }).policy).toBe('allow');
    const third = guard.checkToolCall('read_file', { path: 'a.ts' });
    expect(third.policy).toBe('warn');
    expect(third.reason).toContain('read_file');
    expect(third.reason).toContain('3');
  });

  it('keeps warning for every further identical call', () => {
    const guard = new RunawayGuard({}, NO_ENV);
    for (let i = 0; i < 3; i += 1) guard.checkToolCall('bash', { command: 'ls' });
    expect(guard.checkToolCall('bash', { command: 'ls' }).policy).toBe('warn');
    expect(guard.checkToolCall('bash', { command: 'ls' }).reason).toContain('5');
  });

  it('resets the streak on different args or a different tool', () => {
    const guard = new RunawayGuard({}, NO_ENV);
    guard.checkToolCall('read_file', { path: 'a.ts' });
    guard.checkToolCall('read_file', { path: 'a.ts' });
    expect(guard.checkToolCall('read_file', { path: 'b.ts' }).policy).toBe('allow');
    expect(guard.checkToolCall('read_file', { path: 'b.ts' }).policy).toBe('allow');
    expect(guard.checkToolCall('bash', { path: 'b.ts' }).policy).toBe('allow');
    // Two fresh identical calls after the resets stay below the threshold.
    expect(guard.checkToolCall('bash', { path: 'b.ts' }).policy).toBe('allow');
  });

  it('treats equal args with a different key order as the same call', () => {
    const guard = new RunawayGuard({}, NO_ENV);
    guard.checkToolCall('edit_file', { path: 'a.ts', oldString: 'x' });
    guard.checkToolCall('edit_file', { oldString: 'x', path: 'a.ts' });
    expect(guard.checkToolCall('edit_file', { path: 'a.ts', oldString: 'x' }).policy).toBe('warn');
    expect(toolCallHash('edit_file', { a: 1, b: 2 })).toBe(
      toolCallHash('edit_file', { b: 2, a: 1 }),
    );
    expect(toolCallHash('read_file', { a: 1 })).not.toBe(toolCallHash('bash', { a: 1 }));
  });

  it('honors a custom identicalThreshold', () => {
    const guard = new RunawayGuard({ identicalThreshold: 2 }, NO_ENV);
    expect(guard.checkToolCall('bash', { command: 'ls' }).policy).toBe('allow');
    expect(guard.checkToolCall('bash', { command: 'ls' }).policy).toBe('warn');
  });
});

describe('RunawayGuard — stall (abort)', () => {
  it('aborts after K turns without new calls or results', () => {
    const guard = new RunawayGuard({ stallTurns: 2 }, NO_ENV);
    expect(guard.checkTurn(SAME_TURN).policy).toBe('allow'); // first sighting: new evidence
    expect(guard.checkTurn(SAME_TURN).policy).toBe('allow'); // stall 1
    const aborted = guard.checkTurn(SAME_TURN); // stall 2 === K
    expect(aborted.policy).toBe('abort');
    expect(aborted.reason).toContain('2 consecutive turns');
  });

  it('defaults to K = 5 unproductive turns', () => {
    const guard = new RunawayGuard({}, NO_ENV);
    expect(DEFAULT_STALL_TURNS).toBe(5);
    expect(guard.checkTurn(SAME_TURN).policy).toBe('allow');
    for (let i = 1; i < DEFAULT_STALL_TURNS; i += 1) {
      expect(guard.checkTurn(SAME_TURN).policy).toBe('allow');
    }
    expect(guard.checkTurn(SAME_TURN).policy).toBe('abort');
  });

  it('a new call key or a new result clears the stall counter', () => {
    const guard = new RunawayGuard({ stallTurns: 3 }, NO_ENV);
    expect(guard.checkTurn(SAME_TURN).policy).toBe('allow');
    expect(guard.checkTurn(SAME_TURN).policy).toBe('allow'); // stall 1
    expect(guard.checkTurn(SAME_TURN).policy).toBe('allow'); // stall 2
    // New result text for the same call is still progress → counter clears.
    const changed = { callKeys: ['read_file:abc'], results: ['changed content'] };
    expect(guard.checkTurn(changed).policy).toBe('allow');
    expect(guard.checkTurn(changed).policy).toBe('allow'); // stall 1 counted from zero
    expect(guard.checkTurn(changed).policy).toBe('allow'); // stall 2
    // A brand-new call key clears it again.
    expect(
      guard.checkTurn({ callKeys: ['list_files:2'], results: ['changed content'] }).policy,
    ).toBe('allow');
  });

  it('treats an empty turn (pure synthesis) as neutral', () => {
    const guard = new RunawayGuard({ stallTurns: 1 }, NO_ENV);
    for (let i = 0; i < 5; i += 1) {
      expect(guard.checkTurn({ callKeys: [], results: [] }).policy).toBe('allow');
    }
  });
});

describe('RunawayGuard — kill-switch and fail-soft', () => {
  it('ZELARI_RUNAWAY_GUARD=0 disables every verdict', () => {
    const guard = new RunawayGuard({}, OFF_ENV);
    expect(guard.enabled).toBe(false);
    for (let i = 0; i < 10; i += 1) {
      expect(guard.checkToolCall('bash', { command: 'ls' }).policy).toBe('allow');
    }
    for (let i = 0; i < 10; i += 1) {
      expect(guard.checkTurn(SAME_TURN).policy).toBe('allow');
    }
  });

  it('reads the real environment variable and recovers when it is unset', () => {
    expect(runawayGuardEnabled(NO_ENV)).toBe(true);
    expect(runawayGuardEnabled(OFF_ENV)).toBe(false);
    const previous = process.env.ZELARI_RUNAWAY_GUARD;
    process.env.ZELARI_RUNAWAY_GUARD = '0';
    try {
      const guard = new RunawayGuard();
      expect(guard.enabled).toBe(false);
      expect(guard.checkToolCall('bash', { command: 'ls' }).policy).toBe('allow');
    } finally {
      if (previous === undefined) delete process.env.ZELARI_RUNAWAY_GUARD;
      else process.env.ZELARI_RUNAWAY_GUARD = previous;
    }
  });

  it('guardSafely degrades a crash to allow and reports it', () => {
    const sink = vi.fn();
    const verdict = guardSafely(() => {
      throw new Error('boom');
    }, sink);
    expect(verdict.policy).toBe('allow');
    expect(verdict.reason).toContain('fail-soft');
    expect(verdict.reason).toContain('boom');
    expect(sink).toHaveBeenCalledTimes(1);

    // A throwing sink must not escape either.
    expect(() =>
      guardSafely(() => {
        throw new Error('boom');
      }, () => {
        throw new Error('sink exploded');
      }),
    ).not.toThrow();
  });

  it('guardSafely contains a poisoned tool-args object (throwing getter)', () => {
    const guard = new RunawayGuard({}, NO_ENV);
    const poisoned = {
      get path(): string {
        throw new Error('poisoned args');
      },
    };
    const verdict = guardSafely(() => guard.checkToolCall('read_file', poisoned));
    expect(verdict.policy).toBe('allow');
    expect(verdict.reason).toContain('poisoned args');
  });

  it('reset() drops repetition and stall state', () => {
    const guard = new RunawayGuard({ stallTurns: 2 }, NO_ENV);
    guard.checkToolCall('bash', { command: 'ls' });
    guard.checkToolCall('bash', { command: 'ls' });
    guard.checkTurn(SAME_TURN);
    guard.reset();
    expect(guard.checkToolCall('bash', { command: 'ls' }).policy).toBe('allow');
    expect(guard.checkTurn(SAME_TURN).policy).toBe('allow');
  });
});
