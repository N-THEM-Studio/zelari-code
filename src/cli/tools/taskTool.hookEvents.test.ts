/**
 * WS5 (t137) — the SubagentStart / SubagentEnd (+ tentacle Notification) hook
 * seam of a Kraken tentacle.
 *
 * The builders are pure and the fire helpers are fire-and-forget by contract,
 * so this file pins the payload SHAPE and the non-blocking property without
 * spawning a provider: a throwing or hanging subscriber must neither throw into
 * the tentacle nor delay its teardown.
 */

import { describe, expect, it } from 'vitest';
import type { LifecycleHookRunner } from '@zelari/core/harness';
import {
  buildSubagentHookPayload,
  fireSubagentHook,
  fireTentacleEndHooks,
  type SubagentHookInput,
} from './taskTool.js';

interface Call {
  event: string;
  payload: Record<string, unknown>;
  ctx: Record<string, unknown>;
}

function fakeRunner(mode: 'ok' | 'throw' | 'hang' = 'ok'): { calls: Call[]; runner: LifecycleHookRunner } {
  const calls: Call[] = [];
  const record = (event: string) => async (payload: unknown, ctx: unknown) => {
    calls.push({
      event,
      payload: (payload ?? {}) as Record<string, unknown>,
      ctx: (ctx ?? {}) as Record<string, unknown>,
    });
    if (mode === 'throw') throw new Error(`observer ${event} exploded`);
    if (mode === 'hang') await new Promise<void>(() => undefined);
  };
  return {
    calls,
    runner: {
      runPermissionRequest: record('PermissionRequest'),
      runSubagentStart: record('SubagentStart'),
      runSubagentEnd: record('SubagentEnd'),
      runNotification: record('Notification'),
    } as unknown as LifecycleHookRunner,
  };
}

const base: SubagentHookInput = {
  agent: 'general',
  description: 'fix the parser',
  thoroughness: 'normal',
  worktreeMode: 'on',
  worktreePath: '/tmp/wt-1',
  nodeId: 'n1',
  cwd: '/tmp/wt-1',
};

describe('buildSubagentHookPayload (pure)', () => {
  it('reports isolation from the REAL worktree path, not from the mode', () => {
    expect(buildSubagentHookPayload(base)).toEqual({
      agent: 'general',
      description: 'fix the parser',
      thoroughness: 'normal',
      worktreeMode: 'on',
      worktreePath: '/tmp/wt-1',
      nodeId: 'n1',
      cwd: '/tmp/wt-1',
      worktree: true,
    });
    // WS3 `auto`/`on` whose creation failed runs in the SHARED tree.
    expect(buildSubagentHookPayload({ ...base, worktreePath: null }).worktree).toBe(false);
    expect(buildSubagentHookPayload({ ...base, worktreePath: null, worktreeMode: 'auto' })).toMatchObject({
      worktree: false,
      worktreeMode: 'auto',
    });
  });

  it('omits the fields a run did not carry and maps the end fields', () => {
    const minimal = buildSubagentHookPayload({ agent: 'explore', description: 'read', worktreePath: '' });
    expect(minimal).toEqual({ agent: 'explore', description: 'read', worktree: false });
    expect(buildSubagentHookPayload({ ...base, ok: false, durationMs: 12, error: 'verify failed' })).toMatchObject({
      ok: false,
      durationMs: 12,
      error: 'verify failed',
    });
  });
});

describe('fireSubagentHook / fireTentacleEndHooks (fire-and-forget)', () => {
  it('routes each event to its runner method with the payload and correlation', () => {
    const { calls, runner } = fakeRunner();
    const payload = buildSubagentHookPayload(base);
    fireSubagentHook(runner, 'SubagentStart', payload, { sessionId: 's1', cwd: '/tmp/wt-1' });
    fireTentacleEndHooks(
      runner,
      { ...base, ok: true, durationMs: 42 },
      { sessionId: 's1', cwd: '/tmp/wt-1' },
    );
    expect(calls.map((c) => c.event)).toEqual(['SubagentStart', 'SubagentEnd', 'Notification']);
    expect(calls[0]?.payload).toEqual(payload);
    expect(calls[0]?.ctx).toEqual({ sessionId: 's1', cwd: '/tmp/wt-1' });
    expect(calls[1]?.payload).toMatchObject({ agent: 'general', ok: true, durationMs: 42 });
    expect(calls[2]?.payload).toMatchObject({
      source: 'tentacle-finished',
      kind: 'task.tentacle_ended',
      summary: 'tentacle finished: general — fix the parser',
      taskId: 'n1',
    });
  });

  it('a FAILED tentacle says so and carries the detail', () => {
    const { calls, runner } = fakeRunner();
    fireTentacleEndHooks(runner, { ...base, ok: false, durationMs: 7, error: 'verify failed' });
    expect(calls[0]?.event).toBe('SubagentEnd');
    expect(calls[0]?.payload).toMatchObject({ ok: false, error: 'verify failed' });
    expect(String(calls[1]?.payload.summary)).toContain('tentacle FAILED');
  });

  it('no runner ⇒ nothing happens (hook surface is opt-in)', () => {
    expect(() => fireSubagentHook(null, 'SubagentStart', buildSubagentHookPayload(base))).not.toThrow();
    expect(() => fireTentacleEndHooks(undefined, base)).not.toThrow();
  });

  it('a THROWING subscriber never reaches the tentacle', () => {
    const { runner } = fakeRunner('throw');
    expect(() => fireSubagentHook(runner, 'SubagentStart', buildSubagentHookPayload(base))).not.toThrow();
    expect(() => fireTentacleEndHooks(runner, base)).not.toThrow();
  });

  it('a HANGING subscriber does not block the caller (returns synchronously)', () => {
    const { calls, runner } = fakeRunner('hang');
    const started = Date.now();
    fireSubagentHook(runner, 'SubagentEnd', buildSubagentHookPayload(base));
    fireTentacleEndHooks(runner, base);
    expect(Date.now() - started).toBeLessThan(200);
    expect(calls.length).toBeGreaterThan(0);
  });
});
