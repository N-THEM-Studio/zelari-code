import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainEvent } from '@zelari/core/shared/events';

// Worktree isolation without git: every krakenWorktree touchpoint is faked so
// the general-tentacle path (worktree → merge → auto-verify) runs end-to-end.
vi.mock('./krakenWorktree.js', () => {
  const handle = {
    id: 'wt-test',
    branch: 'kraken/wt-test',
    path: '/repo/.kraken/wt-impl',
    repoRoot: '/repo',
  };
  return {
    createKrakenWorktree: async () => handle,
    cleanupKrakenWorktree: async () => {},
    formatWorktreeFooter: () => '',
    isKrakenWorktreeEnabled: () => true,
    shouldKeepWorktree: () => false,
    mergeKrakenWorktree: async () => ({ ok: true, merged: true, committed: true, message: 'merged (test)' }),
    isKrakenWorktreeAutoMergeEnabled: () => true,
  };
});

import { createTaskTool } from './taskTool.js';
import type { SubAgentHarness, TaskToolDeps } from './taskTool.js';
import { readKrakenRadio } from './krakenRadio.js';

/** Minimal provider stream: no model output, text-only finish. */
const providerStream = async function* (): AsyncGenerator<never> {
  // intentional: nothing to stream
};

function fakeRegistry(): any {
  return {
    invoke: async () => ({ output: '' }),
    fingerprints: () => [],
    toOpenAITools: () => [],
  };
}

function makeDeps(events: BrainEvent[]): TaskToolDeps {
  return {
    createSubAgentContext: (async () => ({
      model: 'test-model',
      provider: 'test-provider',
      cwd: '.',
      registry: fakeRegistry(),
      tools: [],
      providerStream,
    })) as unknown as TaskToolDeps['createSubAgentContext'],
    harnessFactory: (() =>
      ({
        run: async function* (): AsyncGenerator<BrainEvent> {
          const mk = (e: object) =>
            ({ id: 'e', ts: 0, sessionId: 's', ...e }) as BrainEvent;
          yield mk({ type: 'message_start' });
          yield mk({ type: 'message_delta', delta: 'done' });
          yield mk({ type: 'message_end' });
        },
        cancel: () => {},
      }) as SubAgentHarness) as unknown as TaskToolDeps['harnessFactory'],
    onTentacleEvent: (ev: BrainEvent) => {
      events.push(ev);
    },
  } as TaskToolDeps;
}

describe('task tool live progress captions (t94)', () => {
  let cwd = '';
  let restoreWt: string | undefined;
  let restoreAutoMerge: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'zelari-progress-'));
    restoreWt = process.env.ZELARI_KRAKEN_WORKTREE;
    restoreAutoMerge = process.env.ZELARI_KRAKEN_WORKTREE_AUTO_MERGE;
    delete process.env.ZELARI_KRAKEN_WORKTREE;
    delete process.env.ZELARI_KRAKEN_WORKTREE_AUTO_MERGE;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (restoreWt === undefined) delete process.env.ZELARI_KRAKEN_WORKTREE;
    else process.env.ZELARI_KRAKEN_WORKTREE = restoreWt;
    if (restoreAutoMerge === undefined) delete process.env.ZELARI_KRAKEN_WORKTREE_AUTO_MERGE;
    else process.env.ZELARI_KRAKEN_WORKTREE_AUTO_MERGE = restoreAutoMerge;
    rmSync(cwd, { recursive: true, force: true });
  });

  it('general run captions phase/worktree/merge/verify and mirrors radio progress', async () => {
    const events: BrainEvent[] = [];
    const tool = createTaskTool(makeDeps(events));
    const res = (await (tool as { execute: (a: unknown, c: unknown) => Promise<unknown> }).execute(
      { agent: 'general', prompt: 'implement the slice', description: 'impl slice' },
      { sessionId: 'progress-test', cwd },
    )) as { ok: boolean };

    expect(res.ok).toBe(true);

    const captions = events
      .filter((e) => e.type === 'agent_status')
      .map((e) => (e as unknown as Record<string, unknown>).message)
      .filter((m): m is string => typeof m === 'string');

    expect(captions).toContain('phase: general');
    expect(captions.some((m) => m.startsWith('worktree: ') && m.includes('wt-impl'))).toBe(true);
    expect(captions).toContain('merging…');
    expect(captions).toContain('merge ok');
    expect(captions).toContain('verifying…');

    // Radio dual-write: the same trail lands in .zelari/radio/<session>.jsonl.
    const radio = readKrakenRadio(cwd, 'progress-test', 100);
    const progress = radio.filter((e) => e.kind === 'progress');
    expect(progress.some((e) => e.detail === 'phase: general' && e.agent === 'general')).toBe(true);
    expect(progress.some((e) => e.detail === 'merging…')).toBe(true);
    expect(progress.some((e) => e.detail === 'verifying…')).toBe(true);
  });

  it('emits reasoning heartbeats while the sub-agent is blocked on the model', async () => {
    vi.useFakeTimers();
    const events: BrainEvent[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = makeDeps(events);
    deps.harnessFactory = (() =>
      ({
        run: async function* (): AsyncGenerator<BrainEvent> {
          await gate;
          const mk = (e: object) =>
            ({ id: 'e', ts: 0, sessionId: 's', ...e }) as BrainEvent;
          yield mk({ type: 'message_start' });
          yield mk({ type: 'message_delta', delta: 'done' });
          yield mk({ type: 'message_end' });
        },
        cancel: () => {},
      }) as SubAgentHarness) as unknown as TaskToolDeps['harnessFactory'];

    const tool = createTaskTool(deps);
    const pending = (
      tool as { execute: (a: unknown, c: unknown) => Promise<unknown> }
    ).execute(
      { agent: 'explore', prompt: 'scan', description: 'silent think' },
      { sessionId: 'hb-test', cwd },
    );
    for (let i = 0; i < 50; i += 1) {
      if (events.some((e) => e.type === 'agent_spawned')) break;
      await Promise.resolve();
    }
    expect(events.some((e) => e.type === 'agent_spawned')).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    const captions = events
      .filter((e) => e.type === 'agent_status')
      .map((e) => (e as unknown as { message?: string }).message)
      .filter((m): m is string => typeof m === 'string');
    expect(captions.some((m) => m.startsWith('reasoning ·'))).toBe(true);
    release();
    await pending;
    vi.useRealTimers();
  });
});
