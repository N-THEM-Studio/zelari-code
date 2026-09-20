/**
 * taskTool.worktreeFallback.test — F12 / K2.4 loud shared-tree fallback.
 *
 * When a general tentacle WANTS a worktree but `createKrakenWorktree` throws, it
 * must keep running (fail-open) in the SHARED parent tree — but LOUDLY: a radio
 * `worktree.fallback_shared_tree` event carrying the error excerpt + resolved
 * mode, plus the `onWorktreeFallback` deps callback the graph executor latches
 * to degrade to serial admission.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainEvent } from '@zelari/core/shared/events';

// Worktree creation is the ONE thing this suite makes fail; every other
// krakenWorktree touchpoint stays faked so the run reaches its end without git.
// The isolation resolver stays REAL (spread from the actual module): WS3 made
// its default ON, and this suite pins the `auto` env branch's reporting.
const CREATE_FAILURE = 'fatal: could not create work tree dir (test)';
vi.mock('./krakenWorktree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./krakenWorktree.js')>();
  return {
    ...actual,
    createKrakenWorktree: async () => {
      throw new Error(CREATE_FAILURE);
    },
    createKrakenWorktreeDetailed: async () => {
      throw new Error(CREATE_FAILURE);
    },
    cleanupKrakenWorktree: async () => ({
      removed: true,
      swept: false,
      attempts: 1,
      branch: null,
      branchAction: 'none' as const,
      degraded: null,
    }),
    formatWorktreeFooter: () => '',
    isKrakenWorktreeEnabled: () => false, // the `auto` env branch is what enables it
    shouldKeepWorktree: () => false,
    mergeKrakenWorktree: async () => ({ ok: true, merged: true, committed: true, message: 'merged (test)' }),
    isKrakenWorktreeAutoMergeEnabled: () => false,
  };
});

import {
  runTentacle,
  type SubAgentHarness,
  type TaskToolDeps,
  type WorktreeFallbackInfo,
} from './taskTool.js';
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

function makeDeps(events: BrainEvent[], fallbacks: WorktreeFallbackInfo[]): TaskToolDeps {
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
    onWorktreeFallback: (info) => {
      fallbacks.push(info);
    },
  } as TaskToolDeps;
}

describe('worktree fallback is loud + reported (F12 / K2.4)', () => {
  let cwd = '';
  let restoreWt: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'zelari-wtfb-'));
    restoreWt = process.env.ZELARI_KRAKEN_WORKTREE;
    process.env.ZELARI_KRAKEN_WORKTREE = 'auto';
  });

  afterEach(() => {
    if (restoreWt === undefined) delete process.env.ZELARI_KRAKEN_WORKTREE;
    else process.env.ZELARI_KRAKEN_WORKTREE = restoreWt;
    rmSync(cwd, { recursive: true, force: true });
  });

  it('emits worktree.fallback_shared_tree (reason + mode + nodeId) and reports via the deps callback', async () => {
    const events: BrainEvent[] = [];
    const fallbacks: WorktreeFallbackInfo[] = [];
    const res = await runTentacle({
      deps: makeDeps(events, fallbacks),
      args: { description: 'impl slice', prompt: 'implement the slice' },
      agent: 'general',
      thoroughness: 'medium',
      parentCwd: cwd,
      sessionId: 'wtfb-test',
      nodeId: 'g1',
    });

    // Fail-open: the tentacle STILL runs (in the shared parent tree).
    expect(res.ok).toBe(true);

    const radio = readKrakenRadio(cwd, 'wtfb-test', 100);
    const fb = radio.find((e) => e.kind === 'worktree.fallback_shared_tree');
    expect(
      fb,
      `expected a worktree.fallback_shared_tree event, got: ${JSON.stringify(radio)}`,
    ).toBeTruthy();
    expect(fb!.agent).toBe('general');
    expect(fb!.nodeId).toBe('g1');
    expect(fb!.mode).toBe('auto');
    expect(fb!.reason).toBe(CREATE_FAILURE);
    expect(fb!.detail).toContain(CREATE_FAILURE);

    // The deps callback carries the same info to the graph executor.
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toEqual({
      code: 'worktree-create-threw',
      reason: CREATE_FAILURE,
      mode: 'auto',
      nodeId: 'g1',
    });
  });

  it('does NOT emit the fallback event when no worktree was wanted (read-only/explore)', async () => {
    const events: BrainEvent[] = [];
    const fallbacks: WorktreeFallbackInfo[] = [];
    const res = await runTentacle({
      deps: makeDeps(events, fallbacks),
      args: { description: 'scan tree', prompt: 'scan the tree' },
      agent: 'explore',
      thoroughness: 'medium',
      parentCwd: cwd,
      sessionId: 'wtfb-explore',
    });

    expect(res.ok).toBe(true);
    const radio = readKrakenRadio(cwd, 'wtfb-explore', 100);
    expect(radio.some((e) => e.kind === 'worktree.fallback_shared_tree')).toBe(false);
    expect(fallbacks).toHaveLength(0);
  });
});
