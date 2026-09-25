/**
 * Harness hardening from the 2026-09-24 post-mortem (session a27eb8fe):
 *
 *   - a general whose worktree merge-back FAILED has edits that never reached
 *     the parent tree: the task wrapper must not spend a verify (and a rework)
 *     on them, and must tell the parent where the work is;
 *   - a tentacle's loop has an explicit hard cap (2x its soft cap), instead of
 *     the harness default that let one deep general run 83 turns;
 *   - the auto-verify chain only gets the time left in the task budget, so the
 *     tool returns before the registry's hard timeout discards the report.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainEvent } from '@zelari/core/shared/events';

const mergeResult = vi.hoisted(() => ({
  value: { ok: true, merged: true, committed: false, message: 'applied 1 file(s)' } as {
    ok: boolean;
    merged: boolean;
    committed: boolean;
    message: string;
    conflict?: boolean;
  },
}));

vi.mock('./krakenWorktree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./krakenWorktree.js')>();
  const handle = {
    id: 'wt-hard',
    branch: 'kraken/wt-hard',
    path: '/repo/.zelari/worktrees/kraken-wt-hard',
    repoRoot: '/repo',
    seedSha: 'seed123',
  };
  return {
    ...actual,
    createKrakenWorktree: async () => handle,
    createKrakenWorktreeDetailed: async () => ({ ok: true as const, handle }),
    cleanupKrakenWorktree: async () => ({
      removed: true,
      swept: false,
      attempts: 1,
      branch: handle.branch,
      branchAction: 'deleted' as const,
      degraded: null,
    }),
    shouldKeepWorktree: () => false,
    isKrakenWorktreeAutoMergeEnabled: () => true,
    mergeKrakenWorktree: async () => mergeResult.value,
  };
});

import {
  AUTO_VERIFY_MIN_WINDOW_MS,
  AUTO_VERIFY_RESERVE_MS,
  autoVerifyBudgetMs,
  createTaskTool,
  resetTaskVerifyObligation,
  TASK_TOOL_TIMEOUT_MS,
  listTaskVerifyObligations,
  tentacleLoopHardCap,
  type SubAgentHarness,
  type TaskToolDeps,
} from './taskTool.js';

const providerStream = async function* (): AsyncGenerator<never> {
  // intentional: nothing to stream
};

function makeDeps(runs: { agentConfigs: unknown[]; onRun?: () => void }): TaskToolDeps {
  return {
    createSubAgentContext: (async () => ({
      model: 'test-model',
      provider: 'test-provider',
      cwd: '.',
      registry: { invoke: async () => ({ output: '' }), fingerprints: () => [], toOpenAITools: () => [] },
      tools: [],
      providerStream,
    })) as unknown as TaskToolDeps['createSubAgentContext'],
    harnessFactory: ((config: unknown) => {
      runs.agentConfigs.push(config);
      return {
        run: async function* (): AsyncGenerator<BrainEvent> {
          runs.onRun?.();
          const mk = (e: object) => ({ id: 'e', ts: 0, sessionId: 's', ...e }) as BrainEvent;
          yield mk({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'edit', args: {} });
          yield mk({ type: 'tool_execution_end', toolCallId: 'c1', isError: false, durationMs: 1, result: 'ok' });
          yield mk({ type: 'message_start' });
          yield mk({ type: 'message_delta', delta: 'done\n\nVERDICT: PASS' });
          yield mk({ type: 'message_end' });
        },
        cancel: () => {},
      } as SubAgentHarness;
    }) as unknown as TaskToolDeps['harnessFactory'],
  } as TaskToolDeps;
}

const ctx = (cwd: string) => ({ cwd, sessionId: 'hardening', signal: new AbortController().signal }) as never;

describe('tentacleLoopHardCap', () => {
  it('defaults to twice the soft cap', () => {
    expect(tentacleLoopHardCap(24, {})).toBe(48);
    expect(tentacleLoopHardCap(12, {})).toBe(24);
  });

  it('honours ZELARI_KRAKEN_TENTACLE_LOOP_FACTOR within 1-5 and never drops below the soft cap', () => {
    expect(tentacleLoopHardCap(20, { ZELARI_KRAKEN_TENTACLE_LOOP_FACTOR: '3' })).toBe(60);
    expect(tentacleLoopHardCap(20, { ZELARI_KRAKEN_TENTACLE_LOOP_FACTOR: '1' })).toBe(20);
    expect(tentacleLoopHardCap(20, { ZELARI_KRAKEN_TENTACLE_LOOP_FACTOR: '0.5' })).toBe(40);
    expect(tentacleLoopHardCap(20, { ZELARI_KRAKEN_TENTACLE_LOOP_FACTOR: '9' })).toBe(40);
    expect(tentacleLoopHardCap(20, { ZELARI_KRAKEN_TENTACLE_LOOP_FACTOR: 'lots' })).toBe(40);
  });
});

describe('autoVerifyBudgetMs', () => {
  it('is the task time left minus the reserve', () => {
    expect(autoVerifyBudgetMs(0, 10 * 60_000)).toBe(TASK_TOOL_TIMEOUT_MS - 10 * 60_000 - AUTO_VERIFY_RESERVE_MS);
  });

  it('is 0 once less than the minimum window is left', () => {
    const late = TASK_TOOL_TIMEOUT_MS - AUTO_VERIFY_RESERVE_MS - AUTO_VERIFY_MIN_WINDOW_MS + 1;
    expect(autoVerifyBudgetMs(0, late)).toBe(0);
  });
});

describe('task wrapper — general hardening', () => {
  let cwd = '';
  let restoreWt: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'zelari-hardening-'));
    restoreWt = process.env.ZELARI_KRAKEN_WORKTREE;
    delete process.env.ZELARI_KRAKEN_WORKTREE;
    resetTaskVerifyObligation();
    mergeResult.value = { ok: true, merged: true, committed: false, message: 'applied 1 file(s)' };
  });

  afterEach(() => {
    vi.useRealTimers();
    if (restoreWt === undefined) delete process.env.ZELARI_KRAKEN_WORKTREE;
    else process.env.ZELARI_KRAKEN_WORKTREE = restoreWt;
    resetTaskVerifyObligation();
    rmSync(cwd, { recursive: true, force: true });
  });

  it('passes an explicit 2x hard cap to the tentacle harness', async () => {
    const runs = { agentConfigs: [] as Array<Record<string, number>> };
    const tool = createTaskTool(makeDeps(runs as never));
    await tool.execute({ description: 'explore', prompt: 'look', agent: 'explore', thoroughness: 'deep' }, ctx(cwd));
    // explore/deep: nominal 12 → soft max(12, 16) = 16 → hard 32 (was max(48, 76) = 76).
    expect(runs.agentConfigs[0]).toMatchObject({ maxToolLoopIterations: 16, maxToolLoopHardCap: 32 });
  });

  it('skips verify and rework when the edits did not reach the parent tree', async () => {
    mergeResult.value = {
      ok: false,
      merged: false,
      committed: false,
      conflict: true,
      message: 'patch does not apply: page.html. Parent tree left untouched',
    };
    const runs = { agentConfigs: [] as unknown[] };
    const tool = createTaskTool(makeDeps(runs));
    const res = await tool.execute(
      { description: 'refine page', prompt: 'edit page.html', agent: 'general' },
      ctx(cwd),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Only the general ran: no verify tentacle, no rework.
    expect(runs.agentConfigs).toHaveLength(1);
    expect(res.value.result).toContain('[kraken:auto-verify] skipped');
    expect(res.value.result).toContain('NOT in the working tree');
    // The obligation stays open with the reason.
    const debts = listTaskVerifyObligations('hardening');
    expect(debts.some((d) => (d.detail ?? '').includes('edits not applied to the working tree'))).toBe(true);
  });

  it('runs the verify when the merge landed', async () => {
    const runs = { agentConfigs: [] as unknown[] };
    const tool = createTaskTool(makeDeps(runs));
    const res = await tool.execute(
      { description: 'refine page', prompt: 'edit page.html', agent: 'general' },
      ctx(cwd),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(runs.agentConfigs).toHaveLength(2); // general + verify
    expect(res.value.result).toContain('verify PASS');
  });

  it('skips the verify chain once the task time budget is spent, keeping the report', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const runs = {
      agentConfigs: [] as unknown[],
      // The general itself eats 44 of the 45 minutes.
      onRun: () => vi.setSystemTime(Date.now() + 44 * 60_000),
    };
    const tool = createTaskTool(makeDeps(runs));
    const res = await tool.execute(
      { description: 'slow build', prompt: 'build it', agent: 'general' },
      ctx(cwd),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(runs.agentConfigs).toHaveLength(1);
    expect(res.value.result).toContain('done'); // the general's report survives
    expect(res.value.result).toContain('task time budget is nearly spent');
  });
});
