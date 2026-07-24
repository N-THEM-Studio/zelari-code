import { describe, it, expect, beforeEach } from 'vitest';
import {
  createGraph,
  type TaskNode,
  type TaskNodeKind,
  type TaskNodeStatus,
} from '@zelari/core';
import { KrakenGraphExecutor } from '../../src/cli/kraken/executor.js';
import type { RunTentacleOptions, TentacleResult } from '../../src/cli/kraken/tentacle.js';
import type {
  WorktreeHandle,
  WorktreeMergeResult,
} from '../../src/cli/tools/krakenWorktree.js';
import { resetKrakenGraphLive } from '../../src/cli/kraken/graphStatus.js';

/** Compact node factory (mirrors packages/core/src/kraken/graph.test.ts). */
function node(id: string, deps: string[] = [], over: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    kind: (over.kind as TaskNodeKind) ?? 'general',
    label: over.label ?? id,
    prompt: over.prompt ?? `do ${id}`,
    deps,
    status: (over.status as TaskNodeStatus) ?? 'pending',
    retryCount: over.retryCount ?? 0,
    maxRetries: over.maxRetries ?? 0,
    ...over,
  };
}

const fakeTaskToolDeps = {
  createSubAgentContext: async () => null,
};

function fakeWorktreeHandle(id: string): WorktreeHandle {
  return { id, branch: `kraken/${id}`, path: `/tmp/${id}`, repoRoot: '/tmp/repo', baseSha: 'abc123' };
}

describe('KrakenGraphExecutor', () => {
  beforeEach(() => {
    resetKrakenGraphLive();
  });

  describe('parallel wave scheduling', () => {
    it('runs disjoint-scope general nodes concurrently and converges the fixture DAG', async () => {
      let inFlight = 0;
      let peakInFlight = 0;
      const calls: string[] = [];

      const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
        calls.push(opts.args.description);
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        // Yield so overlapping calls actually overlap in the event loop.
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return {
          ok: true,
          agent: opts.agent,
          thoroughness: opts.thoroughness,
          model: 'test-model',
          result: `${opts.args.description}: done`,
          footer: '',
          worktreePath: null,
          worktreeHandle: null,
        };
      };

      const graph = createGraph('fixture', [
        node('e1', [], { kind: 'explore', maxRetries: 0 }),
        node('g1', ['e1'], { kind: 'general', scope: ['src/a'], maxRetries: 0 }),
        node('g2', ['e1'], { kind: 'general', scope: ['src/b'], maxRetries: 0 }),
        node('g3', ['e1'], { kind: 'general', scope: ['src/c'], maxRetries: 0 }),
        node('v1', ['g1'], { kind: 'verify', maxRetries: 0 }),
        node('v2', ['g2'], { kind: 'verify', maxRetries: 0 }),
        node('v3', ['g3'], { kind: 'verify', maxRetries: 0 }),
        node('m1', ['v1', 'v2', 'v3'], { kind: 'merge', maxRetries: 0 }),
        node('v-final', ['m1'], { kind: 'verify', maxRetries: 0 }),
      ]);

      const executor = new KrakenGraphExecutor({
        taskToolDeps: fakeTaskToolDeps,
        parentCwd: '/tmp/repo',
        sessionId: 'test-session',
        runTentacleFn,
        worldModelGate: false,
      });

      const summary = await executor.execute(graph);

      expect(summary.converged).toBe(true);
      expect(summary.failedNodeIds).toEqual([]);
      // g1/g2/g3 declare disjoint scopes -> the executor should overlap them.
      expect(peakInFlight).toBeGreaterThanOrEqual(3);
      expect(calls).toContain('g1');
      expect(calls).toContain('g2');
      expect(calls).toContain('g3');
    });

    it('does not overlap general nodes with overlapping/missing scope', async () => {
      let inFlight = 0;
      let peakInFlight = 0;

      const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return {
          ok: true,
          agent: opts.agent,
          thoroughness: opts.thoroughness,
          model: 'test-model',
          result: 'done',
          footer: '',
          worktreePath: null,
          worktreeHandle: null,
        };
      };

      // No scopes declared -> conservative "not parallel" per canRunParallel.
      const graph = createGraph('no-scope', [
        node('g1', [], { kind: 'general', maxRetries: 0 }),
        node('g2', [], { kind: 'general', maxRetries: 0 }),
      ]);

      const executor = new KrakenGraphExecutor({
        taskToolDeps: fakeTaskToolDeps,
        parentCwd: '/tmp/repo',
        sessionId: 'test-session',
        runTentacleFn,
        worldModelGate: false,
      });

      const summary = await executor.execute(graph);
      expect(summary.converged).toBe(true);
      expect(peakInFlight).toBe(1);
    });
  });

  describe('retry + fix budget', () => {
    it('retries, then spawns a fix node, then terminally fails without aborting an independent branch', async () => {
      const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
        if (opts.args.description.includes('bad')) {
          return { ok: false, agent: opts.agent, error: `${opts.args.description} always fails` };
        }
        return {
          ok: true,
          agent: opts.agent,
          thoroughness: opts.thoroughness,
          model: 'test-model',
          result: 'done',
          footer: '',
          worktreePath: null,
          worktreeHandle: null,
        };
      };

      const graph = createGraph('retry-fix', [
        node('bad', [], { kind: 'general', maxRetries: 1, label: 'bad' }),
        node('bad-dependent', ['bad'], { kind: 'verify', maxRetries: 0 }),
        node('good', [], { kind: 'general', maxRetries: 0, label: 'good' }),
      ]);

      const executor = new KrakenGraphExecutor({
        taskToolDeps: fakeTaskToolDeps,
        parentCwd: '/tmp/repo',
        sessionId: 'test-session',
        runTentacleFn,
        fixBudget: 1,
        worldModelGate: false,
      });

      const summary = await executor.execute(graph);

      expect(summary.converged).toBe(false);
      expect(summary.failedNodeIds).toContain('bad');
      // one retry then a fix node, which also fails (fix nodes don't retry further)
      const fixNode = [...graph.nodes.values()].find((n) => n.id.startsWith('fix-bad-'));
      expect(fixNode).toBeDefined();
      expect(fixNode?.status).toBe('error');
      expect(graph.nodes.get('bad')?.retryCount).toBe(1);
      // the dependent of the failed node is cascade-skipped, not stuck pending
      expect(graph.nodes.get('bad-dependent')?.status).toBe('skipped');
      // the independent branch still completes
      expect(graph.nodes.get('good')?.status).toBe('done');
    });
  });

  describe('sequential merge', () => {
    it('merges deferred worktrees one at a time, never concurrently', async () => {
      let merging = false;
      const mergeOrder: string[] = [];

      const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
        if (opts.agent === 'general') {
          return {
            ok: true,
            agent: opts.agent,
            thoroughness: opts.thoroughness,
            model: 'test-model',
            result: 'done',
            footer: '',
            worktreePath: `/tmp/${opts.args.description}`,
            worktreeHandle: fakeWorktreeHandle(opts.args.description),
          };
        }
        return {
          ok: true,
          agent: opts.agent,
          thoroughness: opts.thoroughness,
          model: 'test-model',
          result: 'done',
          footer: '',
          worktreePath: null,
          worktreeHandle: null,
        };
      };

      const mergeFn = async (handle: WorktreeHandle): Promise<WorktreeMergeResult> => {
        if (merging) throw new Error(`concurrent merge detected for ${handle.id}`);
        merging = true;
        mergeOrder.push(handle.id);
        await new Promise((r) => setTimeout(r, 5));
        merging = false;
        return { ok: true, merged: true, committed: true, message: `merged ${handle.id}` };
      };

      const graph = createGraph('merge-order', [
        node('g1', [], { kind: 'general', scope: ['src/a'], maxRetries: 0 }),
        node('g2', [], { kind: 'general', scope: ['src/b'], maxRetries: 0 }),
        node('m1', ['g1', 'g2'], { kind: 'merge', maxRetries: 0 }),
      ]);

      const executor = new KrakenGraphExecutor({
        taskToolDeps: fakeTaskToolDeps,
        parentCwd: '/tmp/repo',
        sessionId: 'test-session',
        runTentacleFn,
        mergeFn,
        worldModelGate: false,
      });

      const summary = await executor.execute(graph);

      expect(summary.converged).toBe(true);
      expect(mergeOrder.sort()).toEqual(['g1', 'g2']);
      expect(graph.nodes.get('m1')?.status).toBe('done');
    });

    it('keeps the branch and surfaces the conflict without auto-resolving', async () => {
      const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => ({
        ok: true,
        agent: opts.agent,
        thoroughness: opts.thoroughness,
        model: 'test-model',
        result: 'done',
        footer: '',
        worktreePath: `/tmp/${opts.args.description}`,
        worktreeHandle: fakeWorktreeHandle(opts.args.description),
      });

      const mergeFn = async (handle: WorktreeHandle): Promise<WorktreeMergeResult> => ({
        ok: false,
        merged: false,
        committed: false,
        conflict: true,
        message: `conflict merging ${handle.id}`,
      });

      const graph = createGraph('merge-conflict', [
        node('g1', [], { kind: 'general', scope: ['src/a'], maxRetries: 0 }),
        node('m1', ['g1'], { kind: 'merge', maxRetries: 0 }),
      ]);

      const executor = new KrakenGraphExecutor({
        taskToolDeps: fakeTaskToolDeps,
        parentCwd: '/tmp/repo',
        sessionId: 'test-session',
        runTentacleFn,
        mergeFn,
        fixBudget: 0,
        worldModelGate: false,
      });

      const summary = await executor.execute(graph);

      expect(summary.converged).toBe(false);
      expect(graph.nodes.get('m1')?.status).toBe('error');
      expect(graph.nodes.get('m1')?.error).toContain('conflict merging g1');
    });
  });

  describe('world-model gate', () => {
    it('is a clean no-op when unconfigured (default auto-detect, no checks.json)', async () => {
      let backtestCalls = 0;
      const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => ({
        ok: true,
        agent: opts.agent,
        thoroughness: opts.thoroughness,
        model: 'test-model',
        result: 'done',
        footer: '',
        worktreePath: null,
        worktreeHandle: null,
      });

      const graph = createGraph('no-gate', [node('e1', [], { kind: 'explore', maxRetries: 0 })]);

      const executor = new KrakenGraphExecutor({
        taskToolDeps: fakeTaskToolDeps,
        // A cwd with no .zelari/world/checks.json -> auto-detect stays off.
        parentCwd: '/tmp/definitely-not-a-real-repo-xyz',
        sessionId: 'test-session',
        runTentacleFn,
        backtestFn: async () => {
          backtestCalls += 1;
          return { ok: true, passed: 0, failed: 0, total: 0, results: [], hypothesisPath: '', checksPath: '' };
        },
      });

      const summary = await executor.execute(graph);

      expect(summary.converged).toBe(true);
      expect(summary.backtest).toBeUndefined();
      expect(backtestCalls).toBe(0);
    });

    it('runs the backtest when explicitly enabled', async () => {
      let backtestCalls = 0;
      const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => ({
        ok: true,
        agent: opts.agent,
        thoroughness: opts.thoroughness,
        model: 'test-model',
        result: 'done',
        footer: '',
        worktreePath: null,
        worktreeHandle: null,
      });

      const graph = createGraph('gated', [node('e1', [], { kind: 'explore', maxRetries: 0 })]);

      const executor = new KrakenGraphExecutor({
        taskToolDeps: fakeTaskToolDeps,
        parentCwd: '/tmp/repo',
        sessionId: 'test-session',
        runTentacleFn,
        worldModelGate: true,
        backtestFn: async () => {
          backtestCalls += 1;
          return { ok: true, passed: 2, failed: 0, total: 2, results: [], hypothesisPath: '', checksPath: '' };
        },
      });

      const summary = await executor.execute(graph);

      expect(summary.converged).toBe(true);
      expect(backtestCalls).toBe(1);
      expect(summary.backtest?.passed).toBe(2);
    });
  });

  describe('node timeout', () => {
    it('bounds a hung tentacle so execute() still resolves, without aborting an independent branch', async () => {
      const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
        if (opts.args.description === 'hangs') {
          // Simulates a stuck sub-agent (hung bash/network call): never resolves.
          return new Promise<TentacleResult>(() => {});
        }
        return {
          ok: true,
          agent: opts.agent,
          thoroughness: opts.thoroughness,
          model: 'test-model',
          result: 'done',
          footer: '',
          worktreePath: null,
          worktreeHandle: null,
        };
      };

      const graph = createGraph('timeout-test', [
        node('hangs', [], { kind: 'general', maxRetries: 0, label: 'hangs' }),
        node('fine', [], { kind: 'general', maxRetries: 0, label: 'fine' }),
      ]);

      const executor = new KrakenGraphExecutor({
        taskToolDeps: fakeTaskToolDeps,
        parentCwd: '/tmp/repo',
        sessionId: 'test-session',
        runTentacleFn,
        nodeTimeoutMs: 20,
        worldModelGate: false,
      });

      const summary = await executor.execute(graph);

      expect(summary.converged).toBe(false);
      expect(graph.nodes.get('hangs')?.status).toBe('error');
      expect(graph.nodes.get('hangs')?.error).toMatch(/timed out/);
      expect(graph.nodes.get('fine')?.status).toBe('done');
    });

    it('nodeTimeoutMs=0 disables the bound', async () => {
      const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => ({
        ok: true,
        agent: opts.agent,
        thoroughness: opts.thoroughness,
        model: 'test-model',
        result: 'done',
        footer: '',
        worktreePath: null,
        worktreeHandle: null,
      });

      const graph = createGraph('no-timeout', [node('g1', [], { kind: 'general', maxRetries: 0 })]);

      const executor = new KrakenGraphExecutor({
        taskToolDeps: fakeTaskToolDeps,
        parentCwd: '/tmp/repo',
        sessionId: 'test-session',
        runTentacleFn,
        nodeTimeoutMs: 0,
        worldModelGate: false,
      });

      const summary = await executor.execute(graph);
      expect(summary.converged).toBe(true);
    });
  });
});
