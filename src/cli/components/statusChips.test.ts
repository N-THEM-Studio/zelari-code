/**
 * statusChips.test.ts — slice 5 of the 2026-09-15 input-lag diagnosis.
 *
 * The jail chip used to be computed in App's render body: every keystroke (and
 * every streaming tick) reached `probeJailBackend()`. With a test backend
 * injected the probe runs fresh on every call, which makes the cost
 * observable here — the acceptance is "a repaint with identical props does not
 * re-execute the expensive probe".
 *
 * The `statusBarPropsEqual` half pins the memo contract that lets a cached
 * chip actually save the repaint: App recreates the chip objects each render,
 * so identity can never be the comparison.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  cachedJailStatusChip,
  jailStatusChip,
  resetJailChipCacheForTests,
} from './statusChips.js';
import { setJailBackendForTests, type JailBackend } from '../safety/osJail.js';
import { statusBarPropsEqual, type StatusBarProps } from './StatusBar.js';

/** Backend stub whose probe COUNTS calls — the test-only injection point of osJail. */
function countingBackend(available: boolean): { backend: JailBackend; calls: { probe: number } } {
  const calls = { probe: 0 };
  const backend: JailBackend = {
    id: available ? 'bwrap' : 'win32-restricted-token',
    probe: () => {
      calls.probe++;
      return {
        backend: available ? 'bwrap' : 'win32-restricted-token',
        available,
        reason: available ? '' : 'no honest backend on this platform',
      };
    },
    wrap: (_spec, program, argv) => ({ program, argv: [...argv] }),
  };
  return { backend, calls };
}

describe('cachedJailStatusChip', () => {
  beforeEach(() => {
    resetJailChipCacheForTests();
  });

  afterEach(() => {
    setJailBackendForTests(null);
    resetJailChipCacheForTests();
  });

  it('probes ONCE and returns the same chip object across repaints', () => {
    const { backend, calls } = countingBackend(true);
    setJailBackendForTests(backend);
    const env: NodeJS.ProcessEnv = { ZELARI_OS_JAIL: 'required' };

    const first = cachedJailStatusChip(env, 'linux');
    expect(first).toEqual({ label: 'jail: on (bwrap)', tone: 'green' });

    // 100 paints of the status bar (keystrokes, streaming ticks, timer ticks).
    for (let paint = 0; paint < 100; paint++) {
      expect(cachedJailStatusChip(env, 'linux')).toBe(first);
    }
    expect(calls.probe).toBe(1);
  });

  it('surfaces the visible advisory when no honest backend exists', () => {
    const { backend, calls } = countingBackend(false);
    setJailBackendForTests(backend);

    expect(cachedJailStatusChip({ ZELARI_OS_JAIL: 'required' }, 'win32')).toEqual({
      label: 'jail: advisory (win32-restricted-token)',
      tone: 'yellow',
    });
    expect(calls.probe).toBe(1);
  });

  it('re-resolves when an input the chip depends on changes', () => {
    const { backend, calls } = countingBackend(true);
    setJailBackendForTests(backend);
    const env: NodeJS.ProcessEnv = { ZELARI_OS_JAIL: 'advisory' };

    const advisory = cachedJailStatusChip(env, 'linux');
    expect(advisory).toEqual({ label: 'jail: advisory (bwrap)', tone: 'yellow' });
    expect(cachedJailStatusChip(env, 'linux')).toBe(advisory);

    // Same env, another platform → different key → one more resolve.
    cachedJailStatusChip(env, 'darwin');
    expect(calls.probe).toBe(2);

    // Same platform, changed env → one more resolve.
    const required = cachedJailStatusChip({ ...env, ZELARI_OS_JAIL: 'required' }, 'linux');
    expect(required).toEqual({ label: 'jail: on (bwrap)', tone: 'green' });
    expect(calls.probe).toBe(3);
  });

  it('hides the chip and never probes when the jail is explicitly off', () => {
    const { backend, calls } = countingBackend(true);
    setJailBackendForTests(backend);

    expect(cachedJailStatusChip({ ZELARI_OS_JAIL: 'off' }, 'linux')).toBeNull();
    expect(calls.probe).toBe(0);
  });

  it('jailStatusChip is pure per call (the cache is what removes the cost)', () => {
    const { backend, calls } = countingBackend(true);
    setJailBackendForTests(backend);

    jailStatusChip({ ZELARI_OS_JAIL: 'required' }, 'linux');
    jailStatusChip({ ZELARI_OS_JAIL: 'required' }, 'linux');
    expect(calls.probe).toBe(2);
  });
});

describe('statusBarPropsEqual', () => {
  const base: StatusBarProps = {
    model: 'grok-4.5',
    provider: 'openai-compatible',
    sessionId: 'abcd1234',
    sessionActive: true,
    busy: true,
    elapsedMs: 1000,
    verify: { label: 'prova: PASS', tone: 'green' },
    permissions: { label: 'write: on', tone: 'green' },
    jail: { label: 'jail: advisory (win32)', tone: 'yellow' },
  };

  it('treats recreated chip objects with the same chrome as equal', () => {
    const next: StatusBarProps = {
      ...base,
      verify: { ...base.verify! },
      permissions: { ...base.permissions! },
      jail: { ...base.jail! },
    };
    expect(next.verify).not.toBe(base.verify);
    expect(statusBarPropsEqual(base, next)).toBe(true);
  });

  it('detects a changed chip label or tone', () => {
    expect(
      statusBarPropsEqual(base, { ...base, verify: { label: 'prova: RIPARA', tone: 'yellow' } }),
    ).toBe(false);
    expect(
      statusBarPropsEqual(base, { ...base, jail: { label: 'jail: on (bwrap)', tone: 'green' } }),
    ).toBe(false);
  });

  it('detects a changed primitive', () => {
    expect(statusBarPropsEqual(base, { ...base, elapsedMs: 1001 })).toBe(false);
    expect(statusBarPropsEqual(base, { ...base, busy: false })).toBe(false);
    expect(statusBarPropsEqual(base, { ...base, model: 'grok-5' })).toBe(false);
    expect(statusBarPropsEqual(base, { ...base, todoSummary: 'todos 3/5' })).toBe(false);
  });

  it('handles absent chips', () => {
    const bare: StatusBarProps = {
      model: 'grok-4.5',
      provider: 'openai-compatible',
      sessionId: 'abcd1234',
      sessionActive: true,
    };
    expect(statusBarPropsEqual(bare, { ...bare })).toBe(true);
    expect(statusBarPropsEqual(bare, { ...bare, verify: { label: 'prova: PASS', tone: 'green' } })).toBe(
      false,
    );
  });
});
