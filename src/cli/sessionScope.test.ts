/**
 * sessionScope.test — multi-chat isolation inside ONE `--serve-harness`
 * process (2026-09-24: concurrent chats overwrote each other's phase, todos,
 * Kraken env, per-turn channels, and every line lacked a routing key).
 *
 * Every scenario interleaves two harness sessions with awaits, exactly as two
 * Desktop chats interleave on the shared sidecar event loop, and pins that
 * each side only ever observes its own state — while code running OUTSIDE a
 * served session keeps the historical process-wide behaviour.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWithSession } from './serve/sessionControl.js';
import {
  disposeSessionScope,
  liveSessionScopeCount,
  sessionLocal,
  setTurnEnv,
  turnEnv,
  turnGlobals,
} from './sessionScope.js';
import { getPhase, setPhase, _resetPhaseForTests } from './phaseState.js';
import { listSessionTodos, writeSessionTodos, _resetSessionTodosForTests } from './sessionTodos.js';
import { applyKrakenTurnEnv } from './runHeadless.js';
import { activePermissionPreset } from './safety/toolPermissions.js';
import { applyTurnPermissionPreset } from './serve/permissionBridge.js';
import { emitEvent } from './headless.js';
import { getKrakenSelection, setKrakenSelection, resetKrakenCandidates } from './kraken/candidateRegistry.js';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

afterEach(() => {
  for (const id of ['A', 'B']) disposeSessionScope(id);
  _resetPhaseForTests();
  _resetSessionTodosForTests();
  delete process.env.ZELARI_KRAKEN_EXPLORE_MODEL;
  delete process.env.ZELARI_PERMISSION_PRESET;
  vi.restoreAllMocks();
});

/** Run two sessions concurrently, interleaving at every `await tick()`. */
async function both<T>(fn: (id: 'A' | 'B') => Promise<T>): Promise<[T, T]> {
  return Promise.all([runWithSession('A', () => fn('A')), runWithSession('B', () => fn('B'))]);
}

describe('sessionLocal / turnGlobals / turnEnv primitives', () => {
  it('sessionLocal: per session inside runWithSession, process value outside', async () => {
    const v = sessionLocal(() => 0);
    v.set(7);
    const [a, b] = await both(async (id) => {
      v.set(id === 'A' ? 1 : 2);
      await tick();
      return v.get();
    });
    expect([a, b]).toEqual([1, 2]);
    expect(v.get()).toBe(7);
  });

  it('turnGlobals: a session bag, globalThis outside', async () => {
    type G = { __zelariProbe?: string };
    const [a, b] = await both(async (id) => {
      turnGlobals<G>().__zelariProbe = id;
      await tick();
      return turnGlobals<G>().__zelariProbe;
    });
    expect([a, b]).toEqual(['A', 'B']);
    expect((globalThis as G).__zelariProbe).toBeUndefined();
  });

  it('turnEnv: session overlay wins, unset keys fall through, process.env untouched', async () => {
    process.env.ZELARI_KRAKEN_EXPLORE_MODEL = 'sidecar-default';
    const [a, b] = await both(async (id) => {
      if (id === 'A') setTurnEnv('ZELARI_KRAKEN_EXPLORE_MODEL', 'model-a');
      await tick();
      return turnEnv().ZELARI_KRAKEN_EXPLORE_MODEL;
    });
    expect(a).toBe('model-a');
    expect(b).toBe('sidecar-default');
    expect(process.env.ZELARI_KRAKEN_EXPLORE_MODEL).toBe('sidecar-default');
  });

  it('turnEnv view supports `in`, spread and keys (child-process env copies)', async () => {
    await runWithSession('A', async () => {
      setTurnEnv('ZELARI_PERMISSION_PRESET', 'strict');
      const env = turnEnv();
      expect('ZELARI_PERMISSION_PRESET' in env).toBe(true);
      expect({ ...env }.ZELARI_PERMISSION_PRESET).toBe('strict');
      expect(Object.keys(env)).toContain('ZELARI_PERMISSION_PRESET');
    });
  });

  it('disposeSessionScope drops the session state', async () => {
    const v = sessionLocal(() => 'init');
    await runWithSession('A', async () => v.set('changed'));
    expect(liveSessionScopeCount()).toBeGreaterThan(0);
    disposeSessionScope('A');
    await runWithSession('A', async () => expect(v.get()).toBe('init'));
  });
});

describe('concurrent chats on one sidecar — no cross-talk', () => {
  it('phase: a build turn never lifts another chat’s plan-phase gate', async () => {
    const [a, b] = await both(async (id) => {
      setPhase(id === 'A' ? 'plan' : 'build');
      await tick();
      return getPhase();
    });
    expect(a).toBe('plan');
    expect(b).toBe('build');
  });

  it('todos: each chat sees only its own list', async () => {
    const [a, b] = await both(async (id) => {
      writeSessionTodos([{ id: 't1', content: `work of ${id}` }]);
      await tick();
      return listSessionTodos().map((t) => t.content);
    });
    expect(a).toEqual(['work of A']);
    expect(b).toEqual(['work of B']);
  });

  it('Kraken tentacle models and the permission preset stay per chat', async () => {
    const [a, b] = await both(async (id) => {
      applyKrakenTurnEnv(id === 'A' ? ({ krakenExploreModel: 'glm-fast' } as never) : ({} as never));
      applyTurnPermissionPreset({ permissionPreset: id === 'A' ? 'strict' : 'yolo' });
      await tick();
      return [turnEnv().ZELARI_KRAKEN_EXPLORE_MODEL, activePermissionPreset()];
    });
    expect(a).toEqual(['glm-fast', 'strict']);
    expect(b).toEqual([undefined, 'yolo']);
    expect(process.env.ZELARI_KRAKEN_EXPLORE_MODEL).toBeUndefined();
    expect(process.env.ZELARI_PERMISSION_PRESET).toBeUndefined();
  });

  it('per-turn Kraken channels: one chat’s reset never wipes the other’s verdict', async () => {
    const verdict = { status: 'selected', requiredChecks: ['npm test'] } as never;
    const [a, b] = await both(async (id) => {
      if (id === 'A') setKrakenSelection(verdict);
      await tick();
      if (id === 'B') resetKrakenCandidates();
      await tick();
      return getKrakenSelection();
    });
    expect(a).toEqual(verdict);
    expect(b).toBeNull();
  });
});

describe('emitEvent — session-routing stamp', () => {
  it('stamps harnessSessionId on every line inside a served session, never outside', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    await both(async (id) => {
      await tick();
      emitEvent({ type: 'message_delta', delta: id, sessionId: `spine-${id}` });
    });
    emitEvent({ type: 'log', message: 'boot' });
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.find((e) => e.delta === 'A')?.harnessSessionId).toBe('A');
    expect(parsed.find((e) => e.delta === 'B')?.harnessSessionId).toBe('B');
    // The spine id is left intact — the stamp is additive.
    expect(parsed.find((e) => e.delta === 'A')?.sessionId).toBe('spine-A');
    expect('harnessSessionId' in parsed.find((e) => e.type === 'log')!).toBe(false);
  });
});
