import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createGraph,
  type TaskNode,
  type TaskNodeKind,
  type TaskNodeStatus,
} from '@zelari/core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  KrakenGraphExecutor,
  resolveNodeTimeoutMs,
  buildUpstreamContext,
  thoroughnessForKind,
  MAX_UPSTREAM_CHARS_PER_DEP,
  MAX_UPSTREAM_CHARS_TOTAL,
  DEFAULT_NODE_TIMEOUT_MS,
  DEFAULT_WRITER_NODE_TIMEOUT_MS,
  resolveFixBudget,
  resolveGraphTimeoutMs,
  resolveMaxReviewRounds,
} from '../../src/cli/kraken/executor.js';
import { buildGraphFromPlan } from '../../src/cli/kraken/planner.js';
import type { RunTentacleOptions, TentacleResult } from '../../src/cli/kraken/tentacle.js';
import type {
  WorktreeHandle,
  WorktreeMergeResult,
} from '../../src/cli/tools/krakenWorktree.js';
import {
  resetKrakenGraphLive,
  getKrakenGraphLive,
} from '../../src/cli/kraken/graphStatus.js';
import { listCheckpoints } from '../../src/cli/checkpoint/checkpointManager.js';
import { readKrakenRadio } from '../../src/cli/tools/krakenRadio.js';
import type { ReputationRecord } from '../../src/cli/kraken/modelReputation.js';

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

/**
 * Hermetic reputation store for EVERY TEST in this file (t30): the spawn-ROI
 * gate and the t29 recording hook both resolve their store via
 * ZELARI_REPUTATION_PATH. Without a per-test pin they would read/write a
 * shared accumulating store (machine-local default for parentCwd '/tmp/repo'),
 * making admission scores — and thus these tests — depend on records written
 * by earlier tests. A fresh missing file per test ⇒ loadRecords [] ⇒ all-null
 * ROI scores ⇒ spawn, i.e. exactly the pre-t30 behavior. (Within one run the
 * gate loads the store once at first admit, so nodes settling later in the
 * same run never re-enter the decision.) Per-test overrides (reputation
 * recording suite) run inner-first and restore this pin afterwards.
 */
let hermeticReputationDir: string | undefined;
beforeEach(() => {
  hermeticReputationDir = mkdtempSync(path.join(tmpdir(), 'zelari-executor-rep-'));
  process.env.ZELARI_REPUTATION_PATH = path.join(hermeticReputationDir, 'reputation.jsonl');
});
afterEach(() => {
  if (hermeticReputationDir === undefined) return;
  const pinned = path.join(hermeticReputationDir, 'reputation.jsonl');
  if (process.env.ZELARI_REPUTATION_PATH === pinned) {
    delete process.env.ZELARI_REPUTATION_PATH;
  }
  rmSync(hermeticReputationDir, { recursive: true, force: true });
  hermeticReputationDir = undefined;
});

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

    it('serializes overlapping-scope writers: the second starts only after the first settles', async () => {
      const events: string[] = [];
      let inFlight = 0;
      let peakInFlight = 0;

      const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
        const id = opts.args.description;
        events.push(`start:${id}`);
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight -= 1;
        events.push(`end:${id}`);
        return {
          ok: true,
          agent: opts.agent,
          thoroughness: opts.thoroughness,
          model: 'test-model',
          result: `${id}: done`,
          footer: '',
          worktreePath: null,
          worktreeHandle: null,
        };
      };

      // `src/api` (a directory scope covers its subtree) contains `src/api/x.ts`
      // → file-ownership arbitration must defer g2 until g1 has settled.
      const graph = createGraph('overlap-scope', [
        node('g1', [], { kind: 'general', scope: ['src/api'], maxRetries: 0 }),
        node('g2', [], { kind: 'general', scope: ['src/api/jwt.ts'], maxRetries: 0 }),
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
      // Deferred, not failed: both writers ran, one after the other.
      expect(events).toEqual([
        'start:g1',
        'end:g1',
        'start:g2',
        'end:g2',
      ]);
      expect(peakInFlight).toBe(1);
    });

    it('admits disjoint-scope writers in the same round', async () => {
      let inFlight = 0;
      let peakInFlight = 0;

      const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 15));
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

      const graph = createGraph('disjoint-scope-pair', [
        node('g1', [], { kind: 'general', scope: ['src/a/**'], maxRetries: 0 }),
        node('g2', [], { kind: 'general', scope: ['src/b/**'], maxRetries: 0 }),
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
      // Disjoint scopes ⇒ ownership arbitration keeps both in the same wave.
      expect(peakInFlight).toBe(2);
    });

    it('folds case in scope comparison only when ownershipCaseFolding is set', async () => {
      const makePeak = async (caseFolding: boolean | undefined): Promise<number> => {
        let inFlight = 0;
        let peakInFlight = 0;
        const runTentacleFn = async (): Promise<TentacleResult> => {
          inFlight += 1;
          peakInFlight = Math.max(peakInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 15));
          inFlight -= 1;
          return {
            ok: true,
            agent: 'general',
            thoroughness: 'deep',
            model: 'test-model',
            result: 'done',
            footer: '',
            worktreePath: null,
            worktreeHandle: null,
          };
        };
        const graph = createGraph('case-fold', [
          node('g1', [], { kind: 'general', scope: ['SRC/api'], maxRetries: 0 }),
          node('g2', [], { kind: 'general', scope: ['src/api'], maxRetries: 0 }),
        ]);
        const executor = new KrakenGraphExecutor({
          taskToolDeps: fakeTaskToolDeps,
          parentCwd: '/tmp/repo',
          sessionId: 'test-session',
          runTentacleFn,
          worldModelGate: false,
          ...(caseFolding === undefined ? {} : { ownershipCaseFolding: caseFolding }),
        });
        await executor.execute(graph);
        return peakInFlight;
      };

      // Case-insensitive FS semantics (win32/darwin): same tree → serialize.
      expect(await makePeak(true)).toBe(1);
      // Case-sensitive FS semantics (linux): distinct literals → parallel.
      expect(await makePeak(false)).toBe(2);
    });
  });

  describe('P2.C worktree scheduling (ZELARI_KRAKEN_WORKTREE=auto)', () => {
    const ENV_KEY = 'ZELARI_KRAKEN_WORKTREE';
    let savedEnv: string | undefined;
    beforeEach(() => {
      savedEnv = process.env[ENV_KEY];
      delete process.env[ENV_KEY];
    });
    afterEach(() => {
      if (savedEnv === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = savedEnv;
    });

    /** Count concurrent tentacles while every run succeeds. */
    function makeRunner() {
      let inFlight = 0;
      const state = { peakInFlight: 0 };
      const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
        inFlight += 1;
        state.peakInFlight = Math.max(state.peakInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 15));
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
      return { runTentacleFn, state };
    }

    /**
     * Two writers whose scopes `canRunParallel` (case-sensitive, core) calls
     * disjoint — so both become candidates — but folded ownership arbitration
     * calls overlapping: `src/api` contains `src/api/jwt.ts` (score 0.5 → low).
     */
    function overlappingPair() {
      return createGraph('wt-sched', [
        node('g1', [], { kind: 'general', scope: ['SRC/api'], maxRetries: 0 }),
        node('g2', [], { kind: 'general', scope: ['src/api/jwt.ts'], maxRetries: 0 }),
      ]);
    }

    it('auto: a low-overlap writer is admitted alongside the racing writer, worktree-isolated', async () => {
      process.env[ENV_KEY] = 'auto';
      const { runTentacleFn, state } = makeRunner();
      const executor = new KrakenGraphExecutor({
        taskToolDeps: fakeTaskToolDeps,
        parentCwd: '/tmp/repo',
        sessionId: 'wt-auto-low',
        runTentacleFn,
        worldModelGate: false,
        ownershipCaseFolding: true,
      });

      const summary = await executor.execute(overlappingPair());
      expect(summary.converged).toBe(true);
      // Rescued: both writers ran at once instead of serializing.
      expect(state.peakInFlight).toBe(2);
      const events = readKrakenRadio('/tmp/repo', 'wt-auto-low');
      const evt = events.find((e) => e.kind === 'node_worktree_scheduled');
      expect(evt).toBeDefined();
      expect(evt?.nodeId).toBe('g2');
      expect(evt?.overlapScore).toBe(0.5);
      expect(evt?.rationaleCode).toBe('low-overlap-worktree');
      expect(evt?.runningNode).toBe('g1');
      // The rescued node never went through the plain deferral path.
      expect(events.some((e) => e.kind === 'node_deferred' && e.description === 'g2')).toBe(
        false,
      );
    });

    it('auto: identical-grain (high) overlap still defers the second writer', async () => {
      process.env[ENV_KEY] = 'auto';
      const { runTentacleFn, state } = makeRunner();
      const graph = createGraph('wt-auto-high', [
        node('g1', [], { kind: 'general', scope: ['SRC/api'], maxRetries: 0 }),
        node('g2', [], { kind: 'general', scope: ['src/api'], maxRetries: 0 }),
      ]);
      const executor = new KrakenGraphExecutor({
        taskToolDeps: fakeTaskToolDeps,
        parentCwd: '/tmp/repo',
        sessionId: 'wt-auto-high',
        runTentacleFn,
        worldModelGate: false,
        ownershipCaseFolding: true,
      });

      await executor.execute(graph);
      // Folded scopes are the same claim (score 1 → high) → sequential as ever.
      expect(state.peakInFlight).toBe(1);
      const events = readKrakenRadio('/tmp/repo', 'wt-auto-high');
      expect(events.some((e) => e.kind === 'node_deferred' && e.description === 'g2')).toBe(
        true,
      );
      expect(events.some((e) => e.kind === 'node_worktree_scheduled')).toBe(false);
    });

    it('default env (unset): low-overlap pair still serializes exactly as before', async () => {
      const { runTentacleFn, state } = makeRunner();
      const executor = new KrakenGraphExecutor({
        taskToolDeps: fakeTaskToolDeps,
        parentCwd: '/tmp/repo',
        sessionId: 'wt-default',
        runTentacleFn,
        worldModelGate: false,
        ownershipCaseFolding: true,
      });

      await executor.execute(overlappingPair());
      expect(state.peakInFlight).toBe(1);
      const events = readKrakenRadio('/tmp/repo', 'wt-default');
      expect(events.some((e) => e.kind === 'node_deferred' && e.description === 'g2')).toBe(
        true,
      );
      expect(events.some((e) => e.kind === 'node_worktree_scheduled')).toBe(false);
    });

    it('auto: a writer whose deps disable worktrees cannot be isolated and stays deferred', async () => {
      process.env[ENV_KEY] = 'auto';
      const { runTentacleFn, state } = makeRunner();
      const executor = new KrakenGraphExecutor({
        taskToolDeps: { ...fakeTaskToolDeps, allowWorktree: false },
        parentCwd: '/tmp/repo',
        sessionId: 'wt-auto-nocap',
        runTentacleFn,
        worldModelGate: false,
        ownershipCaseFolding: true,
      });

      await executor.execute(overlappingPair());
      expect(state.peakInFlight).toBe(1);
      const events = readKrakenRadio('/tmp/repo', 'wt-auto-nocap');
      expect(events.some((e) => e.kind === 'node_deferred' && e.description === 'g2')).toBe(
        true,
      );
      expect(events.some((e) => e.kind === 'node_worktree_scheduled')).toBe(false);
    });

    it('auto: read-only nodes overlap freely and are never worktree-scheduled', async () => {
      process.env[ENV_KEY] = 'auto';
      const { runTentacleFn, state } = makeRunner();
      const graph = createGraph('wt-auto-readonly', [
        node('v1', [], { kind: 'verify', scope: ['src/api'], maxRetries: 0 }),
        node('v2', [], { kind: 'verify', scope: ['src/api'], maxRetries: 0 }),
      ]);
      const executor = new KrakenGraphExecutor({
        taskToolDeps: fakeTaskToolDeps,
        parentCwd: '/tmp/repo',
        sessionId: 'wt-auto-readonly',
        runTentacleFn,
        worldModelGate: false,
      });

      await executor.execute(graph);
      expect(state.peakInFlight).toBe(2);
      expect(
        readKrakenRadio('/tmp/repo', 'wt-auto-readonly').some(
          (e) => e.kind === 'node_worktree_scheduled',
        ),
      ).toBe(false);
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
        // This tentacle ignores the cancel signal too, so keep the unwind
        // grace short — the point of the test is that execute() settles.
        cancelGraceMs: 20,
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

    /**
     * Regression: a real graph lost both of its largest `general` nodes to
     * `tentacle timed out after 300000ms` — 5 minutes is a reader's budget,
     * not enough for a node that scaffolds a project across many files.
     */
    describe('resolveNodeTimeoutMs — per-kind budgets', () => {
      it('gives writers a larger default budget than readers', () => {
        expect(resolveNodeTimeoutMs({}, 'general')).toBe(DEFAULT_WRITER_NODE_TIMEOUT_MS);
        expect(resolveNodeTimeoutMs({}, 'explore')).toBe(DEFAULT_NODE_TIMEOUT_MS);
        expect(resolveNodeTimeoutMs({}, 'verify')).toBe(DEFAULT_NODE_TIMEOUT_MS);
        expect(DEFAULT_WRITER_NODE_TIMEOUT_MS).toBeGreaterThan(DEFAULT_NODE_TIMEOUT_MS);
        expect(DEFAULT_WRITER_NODE_TIMEOUT_MS).toBe(2_700_000);
      });

      it('keeps the no-agent default unchanged for existing callers', () => {
        expect(resolveNodeTimeoutMs({})).toBe(DEFAULT_NODE_TIMEOUT_MS);
      });

      it('lets ZELARI_KRAKEN_NODE_TIMEOUT_MS override every kind', () => {
        const env = { ZELARI_KRAKEN_NODE_TIMEOUT_MS: '1234' };
        expect(resolveNodeTimeoutMs(env, 'general')).toBe(1234);
        expect(resolveNodeTimeoutMs(env, 'explore')).toBe(1234);
        expect(resolveNodeTimeoutMs({ ZELARI_KRAKEN_NODE_TIMEOUT_MS: '0' }, 'general')).toBe(0);
      });

      it('lets ZELARI_KRAKEN_WRITER_NODE_TIMEOUT_MS override only writers', () => {
        const env = { ZELARI_KRAKEN_WRITER_NODE_TIMEOUT_MS: '77' };
        expect(resolveNodeTimeoutMs(env, 'general')).toBe(77);
        expect(resolveNodeTimeoutMs(env, 'explore')).toBe(DEFAULT_NODE_TIMEOUT_MS);
      });

      it('falls back to the default on an unparseable value', () => {
        expect(resolveNodeTimeoutMs({ ZELARI_KRAKEN_NODE_TIMEOUT_MS: 'soon' }, 'general')).toBe(
          DEFAULT_WRITER_NODE_TIMEOUT_MS,
        );
      });
    });

    it('applies the writer budget to a fix node (mapped to the general agent)', async () => {
      const seen: Array<{ description: string; agent: string }> = [];
      const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
        seen.push({ description: opts.args.description, agent: opts.agent });
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

      const graph = createGraph('fix-agent', [node('g1', [], { kind: 'fix', maxRetries: 0 })]);

      const executor = new KrakenGraphExecutor({
        taskToolDeps: fakeTaskToolDeps,
        parentCwd: '/tmp/repo',
        sessionId: 'test-session',
        runTentacleFn,
        worldModelGate: false,
      });

      await executor.execute(graph);

      expect(seen[0]?.agent).toBe('general');
    });

    /**
     * Regression for the worst observed graph failure: g-ships blew its
     * budget, the executor retried it and then spawned a fix node, and all
     * three attempts wrote src/ships/ CONCURRENTLY — the original tentacle
     * was never cancelled, it just stopped being waited on. The result was
     * two parallel implementations of the same modules (Corvette.js and
     * CorvetteShip.js, written a minute apart by different agents).
     */
    describe('cancellation on timeout', () => {
      it('aborts the tentacle signal when the node budget is blown', async () => {
        let sawAbort = false;
        const runTentacleFn = (opts: RunTentacleOptions): Promise<TentacleResult> =>
          new Promise<TentacleResult>((resolve) => {
            opts.signal?.addEventListener('abort', () => {
              sawAbort = true;
              // A well-behaved tentacle unwinds when told to.
              resolve({ ok: false, agent: opts.agent, error: 'cancelled', cancelled: true });
            });
          });

        const graph = createGraph('cancel-test', [
          node('g1', [], { kind: 'general', maxRetries: 0 }),
        ]);

        const executor = new KrakenGraphExecutor({
          taskToolDeps: fakeTaskToolDeps,
          parentCwd: '/tmp/repo',
          sessionId: 'test-session',
          runTentacleFn,
          nodeTimeoutMs: 20,
          worldModelGate: false,
        });

        await executor.execute(graph);

        expect(sawAbort).toBe(true);
        expect(graph.nodes.get('g1')?.status).toBe('error');
      });

      it('does NOT re-spawn a node whose previous run refused to stop', async () => {
        let spawns = 0;
        // Never resolves, never honours the abort — the pathological case.
        const runTentacleFn = (_opts: RunTentacleOptions): Promise<TentacleResult> => {
          spawns += 1;
          return new Promise<TentacleResult>(() => {});
        };

        // maxRetries: 1 — the old code would have started a second concurrent
        // writer here, plus a third via the fix node.
        const graph = createGraph('no-respawn', [
          node('g1', [], { kind: 'general', maxRetries: 1 }),
        ]);

        const executor = new KrakenGraphExecutor({
          taskToolDeps: fakeTaskToolDeps,
          parentCwd: '/tmp/repo',
          sessionId: 'test-session',
          runTentacleFn,
          nodeTimeoutMs: 10,
          cancelGraceMs: 10,
          fixBudget: 2,
          worldModelGate: false,
        });

        const summary = await executor.execute(graph);

        expect(spawns).toBe(1);
        expect(summary.converged).toBe(false);
        expect(graph.nodes.get('g1')?.error).toMatch(/did not stop/);
      });

      it('keeps a result that succeeds just after the deadline', async () => {
        // The tentacle finishes in the window between the timeout firing and
        // the abort landing. Discarding that would throw away work already
        // written to disk over a few milliseconds.
        const runTentacleFn = (opts: RunTentacleOptions): Promise<TentacleResult> =>
          new Promise<TentacleResult>((resolve) => {
            setTimeout(
              () =>
                resolve({
                  ok: true,
                  agent: opts.agent,
                  thoroughness: opts.thoroughness,
                  model: 'test-model',
                  result: 'landed late',
                  footer: '',
                  worktreePath: null,
                  worktreeHandle: null,
                }),
              40,
            );
          });

        const graph = createGraph('late-success', [
          node('g1', [], { kind: 'general', maxRetries: 0 }),
        ]);

        const executor = new KrakenGraphExecutor({
          taskToolDeps: fakeTaskToolDeps,
          parentCwd: '/tmp/repo',
          sessionId: 'test-session',
          runTentacleFn,
          nodeTimeoutMs: 10,
          cancelGraceMs: 500,
          worldModelGate: false,
        });

        const summary = await executor.execute(graph);

        expect(summary.converged).toBe(true);
        expect(graph.nodes.get('g1')?.status).toBe('done');
        expect(graph.nodes.get('g1')?.result).toBe('landed late');
      });

      it('still retries when the run confirms it stopped', async () => {
        let spawns = 0;
        const runTentacleFn = (opts: RunTentacleOptions): Promise<TentacleResult> => {
          spawns += 1;
          if (spawns === 1) {
            return new Promise<TentacleResult>((resolve) => {
              opts.signal?.addEventListener('abort', () =>
                resolve({ ok: false, agent: opts.agent, error: 'stopped', cancelled: true }),
              );
            });
          }
          return Promise.resolve({
            ok: true,
            agent: opts.agent,
            thoroughness: opts.thoroughness,
            model: 'test-model',
            result: 'done',
            footer: '',
            worktreePath: null,
            worktreeHandle: null,
          });
        };

        const graph = createGraph('retry-ok', [node('g1', [], { kind: 'general', maxRetries: 1 })]);

        const executor = new KrakenGraphExecutor({
          taskToolDeps: fakeTaskToolDeps,
          parentCwd: '/tmp/repo',
          sessionId: 'test-session',
          runTentacleFn,
          nodeTimeoutMs: 20,
          cancelGraceMs: 200,
          worldModelGate: false,
        });

        const summary = await executor.execute(graph);

        expect(spawns).toBe(2);
        expect(summary.converged).toBe(true);
      });
    });
  });
});

describe('upstream context propagation', () => {
  it('renders completed dependency results as a prompt section', () => {
    const graph = createGraph('ctx', [
      node('e1', [], { kind: 'explore', label: 'find auth', status: 'done', result: 'auth lives in src/auth/jwt.ts' }),
      node('e2', [], { kind: 'explore', label: 'find db', status: 'done', result: 'db is sqlite' }),
      node('g1', ['e1', 'e2'], { kind: 'general' }),
    ]);

    const ctx = buildUpstreamContext(graph, graph.nodes.get('g1')!);

    expect(ctx).toContain('## Context from completed upstream tasks');
    expect(ctx).toContain('### find auth (explore)');
    expect(ctx).toContain('auth lives in src/auth/jwt.ts');
    expect(ctx).toContain('### find db (explore)');
    expect(ctx).toContain('db is sqlite');
  });

  it('includes a dependency scope in its heading', () => {
    const graph = createGraph('ctx-scope', [
      node('g1', [], { kind: 'general', label: 'A', scope: ['src/a'], status: 'done', result: 'wrote src/a/x.ts' }),
      node('v1', ['g1'], { kind: 'verify' }),
    ]);
    expect(buildUpstreamContext(graph, graph.nodes.get('v1')!)).toContain(
      '### A (general, scope: src/a)',
    );
  });

  it('omits dependencies that are not done, produced nothing, or are unknown', () => {
    const graph = createGraph('ctx-partial', [
      node('e1', [], { kind: 'explore', status: 'error', result: 'never mind' }),
      node('e2', [], { kind: 'explore', status: 'done', result: '   ' }),
      node('g1', ['e1', 'e2', 'ghost'], { kind: 'general' }),
    ]);
    expect(buildUpstreamContext(graph, graph.nodes.get('g1')!)).toBe('');
  });

  it('truncates a single verbose dependency to the per-dep cap', () => {
    const long = 'x'.repeat(MAX_UPSTREAM_CHARS_PER_DEP + 500);
    const graph = createGraph('ctx-trunc', [
      node('e1', [], { kind: 'explore', label: 'noisy', status: 'done', result: long }),
      node('g1', ['e1'], { kind: 'general' }),
    ]);

    const ctx = buildUpstreamContext(graph, graph.nodes.get('g1')!);

    expect(ctx).toContain(`truncated ${long.length}→${MAX_UPSTREAM_CHARS_PER_DEP} chars`);
    expect(ctx.length).toBeLessThan(long.length);
  });

  it('stops at the total budget and names what it dropped', () => {
    // A character that never occurs in the section's own prose, so counting it
    // measures exactly the injected payload.
    const blob = '§'.repeat(MAX_UPSTREAM_CHARS_PER_DEP);
    const deps: TaskNode[] = [];
    const ids: string[] = [];
    // 4 deps x per-dep cap > total cap, so the last one cannot fit.
    for (let i = 1; i <= 4; i++) {
      deps.push(node(`e${i}`, [], { kind: 'explore', label: `dep ${i}`, status: 'done', result: blob }));
      ids.push(`e${i}`);
    }
    const graph = createGraph('ctx-budget', [...deps, node('g1', ids, { kind: 'general' })]);

    const ctx = buildUpstreamContext(graph, graph.nodes.get('g1')!);

    expect(ctx).toContain('omitted for context budget: dep 4');
    expect(ctx).not.toContain('### dep 4 (explore)');
    // the injected blobs stay within the declared total budget
    expect((ctx.match(/§/g) ?? []).length).toBe(MAX_UPSTREAM_CHARS_TOTAL);
  });

  it('feeds explore findings to the general node and the general result to its verify node', async () => {
    const prompts: Record<string, string> = {};
    const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
      prompts[opts.nodeId ?? '?'] = opts.args.prompt;
      return {
        ok: true,
        agent: opts.agent,
        thoroughness: opts.thoroughness,
        model: 'test-model',
        result: `${opts.nodeId} concluded something specific`,
        footer: '',
        worktreePath: null,
        worktreeHandle: null,
      };
    };

    const graph = buildGraphFromPlan('planner-shape', [
      { id: 'e1', kind: 'explore', label: 'survey', prompt: 'survey the repo', deps: [] },
      { id: 'g1', kind: 'general', label: 'build', prompt: 'build the thing', deps: ['e1'] },
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
    // the explore node itself has no deps -> unchanged prompt
    expect(prompts['e1']).toBe('survey the repo');
    // the general node receives the explore conclusion
    expect(prompts['g1']).toContain('build the thing');
    expect(prompts['g1']).toContain('## Context from completed upstream tasks');
    expect(prompts['g1']).toContain('e1 concluded something specific');
    // the auto-injected verify node receives what the writer reported
    expect(prompts['verify-g1']).toContain('g1 concluded something specific');
  });
});

describe('per-kind tool budget', () => {
  it('gives writers a deeper budget than read-only kinds', () => {
    expect(thoroughnessForKind('general')).toBe('deep');
    expect(thoroughnessForKind('fix')).toBe('deep');
    expect(thoroughnessForKind('explore')).toBe('medium');
    expect(thoroughnessForKind('verify')).toBe('medium');
  });

  it('passes the per-kind thoroughness to the tentacle', async () => {
    const seen: Record<string, string> = {};
    const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
      seen[opts.nodeId ?? '?'] = opts.thoroughness;
      return {
        ok: true,
        agent: opts.agent,
        thoroughness: opts.thoroughness,
        model: 'test-model',
        result: 'ok',
        footer: '',
        worktreePath: null,
        worktreeHandle: null,
      };
    };

    const graph = createGraph('budget', [
      node('e1', [], { kind: 'explore', maxRetries: 0 }),
      node('g1', ['e1'], { kind: 'general', maxRetries: 0 }),
      node('v1', ['g1'], { kind: 'verify', maxRetries: 0 }),
    ]);

    await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      runTentacleFn,
      worldModelGate: false,
    }).execute(graph);

    expect(seen).toEqual({ e1: 'medium', g1: 'deep', v1: 'medium' });
  });
});

describe('merge node source resolution', () => {
  /** Fake runner that hands back a worktree handle for every writer node. */
  const writerWorktreeRunner = async (opts: RunTentacleOptions): Promise<TentacleResult> => ({
    ok: true,
    agent: opts.agent,
    thoroughness: opts.thoroughness,
    model: 'test-model',
    result: `${opts.nodeId} done`,
    footer: '',
    worktreePath: opts.agent === 'general' ? `/tmp/${opts.nodeId}` : null,
    worktreeHandle: opts.agent === 'general' ? fakeWorktreeHandle(opts.nodeId ?? 'x') : null,
  });

  const noWorktreeRunner = async (opts: RunTentacleOptions): Promise<TentacleResult> => ({
    ok: true,
    agent: opts.agent,
    thoroughness: opts.thoroughness,
    model: 'test-model',
    result: 'done',
    footer: '',
    worktreePath: null,
    worktreeHandle: null,
  });

  it('merges the writers behind the verify nodes a planned merge depends on', async () => {
    const merged: string[] = [];
    const mergeFn = async (handle: WorktreeHandle): Promise<WorktreeMergeResult> => {
      merged.push(handle.id);
      return { ok: true, merged: true, committed: true, message: `merged ${handle.id}` };
    };

    // Exactly the shape planTaskGraph produces: merge -> verify-* -> general.
    const graph = buildGraphFromPlan('planned-merge', [
      { id: 'g1', kind: 'general', label: 'a', prompt: 'a', deps: [], scope: ['src/a'] },
      { id: 'g2', kind: 'general', label: 'b', prompt: 'b', deps: [], scope: ['src/b'] },
    ]);

    const summary = await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      runTentacleFn: writerWorktreeRunner,
      mergeFn,
      worldModelGate: false,
    }).execute(graph);

    expect(summary.converged).toBe(true);
    expect([...merged].sort()).toEqual(['g1', 'g2']);
    expect(graph.nodes.get('merge')?.result).toContain('merged: ');
  });

  it('merges ancestor writers before the writers that depend on them', async () => {
    const merged: string[] = [];
    const mergeFn = async (handle: WorktreeHandle): Promise<WorktreeMergeResult> => {
      merged.push(handle.id);
      return { ok: true, merged: true, committed: true, message: 'ok' };
    };

    const graph = createGraph('ordered-merge', [
      node('g1', [], { kind: 'general', maxRetries: 0 }),
      node('g2', ['g1'], { kind: 'general', maxRetries: 0 }),
      node('v1', ['g1'], { kind: 'verify', maxRetries: 0 }),
      node('v2', ['g2'], { kind: 'verify', maxRetries: 0 }),
      node('m1', ['v1', 'v2'], { kind: 'merge', maxRetries: 0 }),
    ]);

    await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      runTentacleFn: writerWorktreeRunner,
      mergeFn,
      worldModelGate: false,
    }).execute(graph);

    expect(merged).toEqual(['g1', 'g2']);
  });

  it('does not merge the same writer twice when two merge nodes cover it', async () => {
    const merged: string[] = [];
    const mergeFn = async (handle: WorktreeHandle): Promise<WorktreeMergeResult> => {
      merged.push(handle.id);
      return { ok: true, merged: true, committed: true, message: 'ok' };
    };

    const graph = createGraph('double-merge', [
      node('g1', [], { kind: 'general', maxRetries: 0 }),
      node('v1', ['g1'], { kind: 'verify', maxRetries: 0 }),
      node('m1', ['v1'], { kind: 'merge', maxRetries: 0 }),
      node('m2', ['v1'], { kind: 'merge', maxRetries: 0 }),
    ]);

    await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      runTentacleFn: writerWorktreeRunner,
      mergeFn,
      worldModelGate: false,
    }).execute(graph);

    expect(merged).toEqual(['g1']);
  });

  it('reports nothing to merge when worktree isolation produced no handles', async () => {
    const merged: string[] = [];
    const mergeFn = async (handle: WorktreeHandle): Promise<WorktreeMergeResult> => {
      merged.push(handle.id);
      return { ok: true, merged: true, committed: true, message: 'ok' };
    };

    const graph = buildGraphFromPlan('no-wt', [
      { id: 'g1', kind: 'general', label: 'a', prompt: 'a', deps: [], scope: ['src/a'] },
      { id: 'g2', kind: 'general', label: 'b', prompt: 'b', deps: [], scope: ['src/b'] },
    ]);

    await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      runTentacleFn: noWorktreeRunner,
      mergeFn,
      worldModelGate: false,
    }).execute(graph);

    expect(merged).toEqual([]);
    expect(graph.nodes.get('merge')?.result).toBe('nothing to merge');
  });
});

describe('repair reconciliation', () => {
  it('converges when a spawned fix completes the work the failed node could not', async () => {
    let firstAttempt = true;
    const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
      if (opts.nodeId === 'g1' && firstAttempt) {
        firstAttempt = false;
        return { ok: false, agent: opts.agent, error: 'boom', cancelled: true };
      }
      return {
        ok: true,
        agent: opts.agent,
        thoroughness: opts.thoroughness,
        model: 'test-model',
        result: `${opts.nodeId} ok`,
        footer: '',
        worktreePath: null,
        worktreeHandle: null,
      };
    };

    const graph = createGraph('repaired', [
      node('g1', [], { kind: 'general', label: 'build', maxRetries: 0 }),
      node('v1', ['g1'], { kind: 'verify', maxRetries: 0 }),
    ]);

    const summary = await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      runTentacleFn,
      fixBudget: 1,
      worldModelGate: false,
    }).execute(graph);

    const fixNode = [...graph.nodes.values()].find((n) => n.kind === 'fix');
    expect(fixNode?.status).toBe('done');
    // the repaired node reports the work as done, with provenance preserved
    const g1 = graph.nodes.get('g1');
    expect(g1?.status).toBe('done');
    expect(g1?.result).toContain('repaired by "fix: build"');
    expect(g1?.result).toContain('original failure: boom');
    expect(g1?.error).toBeUndefined();
    // the dependent, re-pointed at the fix, still runs
    expect(graph.nodes.get('v1')?.status).toBe('done');
    expect(summary.converged).toBe(true);
    expect(summary.failedNodeIds).toEqual([]);
  });

  it('leaves the node failed when the fix itself fails', async () => {
    const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => ({
      ok: false,
      agent: opts.agent,
      error: 'always fails',
      cancelled: true,
    });

    const graph = createGraph('unrepaired', [
      node('g1', [], { kind: 'general', label: 'build', maxRetries: 0 }),
    ]);

    const summary = await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      runTentacleFn,
      fixBudget: 1,
      worldModelGate: false,
    }).execute(graph);

    expect(graph.nodes.get('g1')?.status).toBe('error');
    expect(graph.nodes.get('g1')?.error).toBe('always fails');
    expect(summary.converged).toBe(false);
    expect(summary.failedNodeIds).toContain('g1');
  });
});

describe('live graph status', () => {
  it('publishes the running count while a wave is in flight', async () => {
    resetKrakenGraphLive();
    let runningWhileInFlight = 0;

    const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
      runningWhileInFlight = Math.max(runningWhileInFlight, getKrakenGraphLive()?.running ?? 0);
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

    const graph = createGraph('live', [
      node('g1', [], { kind: 'general', scope: ['src/a'], maxRetries: 0 }),
      node('g2', [], { kind: 'general', scope: ['src/b'], maxRetries: 0 }),
    ]);

    await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      runTentacleFn,
      worldModelGate: false,
    }).execute(graph);

    expect(runningWhileInFlight).toBe(2);
    expect(getKrakenGraphLive()?.running).toBe(0);
    expect(getKrakenGraphLive()?.done).toBe(2);
  });
});

describe('verify runs where the work happened', () => {
  const writerWorktree = async (opts: RunTentacleOptions): Promise<TentacleResult> => ({
    ok: true,
    agent: opts.agent,
    thoroughness: opts.thoroughness,
    model: 'test-model',
    result: 'done',
    footer: '',
    worktreePath: opts.agent === 'general' ? `/tmp/${opts.nodeId}` : null,
    worktreeHandle: opts.agent === 'general' ? fakeWorktreeHandle(opts.nodeId ?? 'x') : null,
  });

  it('points a verify tentacle at its writer worktree, not the parent tree', async () => {
    const cwds: Record<string, string | undefined> = {};
    const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
      cwds[opts.nodeId ?? '?'] = opts.cwdOverride;
      return writerWorktree(opts);
    };

    const graph = buildGraphFromPlan('verify-cwd', [
      { id: 'g1', kind: 'general', label: 'a', prompt: 'a', deps: [], scope: ['src/a'] },
      { id: 'g2', kind: 'general', label: 'b', prompt: 'b', deps: [], scope: ['src/b'] },
    ]);

    await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      runTentacleFn,
      mergeFn: async () => ({ ok: true, merged: true, committed: true, message: 'ok' }),
      worldModelGate: false,
    }).execute(graph);

    // writers create their own worktree inside runTentacle -> never overridden
    expect(cwds['g1']).toBeUndefined();
    expect(cwds['g2']).toBeUndefined();
    // each verify inspects the tree its writer actually wrote to
    expect(cwds['verify-g1']).toBe(fakeWorktreeHandle('g1').path);
    expect(cwds['verify-g2']).toBe(fakeWorktreeHandle('g2').path);
  });

  it('leaves verify in the parent tree when worktree isolation is off', async () => {
    const cwds: Record<string, string | undefined> = {};
    const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
      cwds[opts.nodeId ?? '?'] = opts.cwdOverride;
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

    const graph = buildGraphFromPlan('verify-no-wt', [
      { id: 'g1', kind: 'general', label: 'a', prompt: 'a', deps: [] },
    ]);

    await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      runTentacleFn,
      worldModelGate: false,
    }).execute(graph);

    expect(cwds['verify-g1']).toBeUndefined();
  });

  it('falls back to the parent tree when a verify spans two worktrees', async () => {
    const cwds: Record<string, string | undefined> = {};
    const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
      cwds[opts.nodeId ?? '?'] = opts.cwdOverride;
      return writerWorktree(opts);
    };

    const graph = createGraph('verify-span', [
      node('g1', [], { kind: 'general', scope: ['src/a'], maxRetries: 0 }),
      node('g2', [], { kind: 'general', scope: ['src/b'], maxRetries: 0 }),
      node('v1', ['g1', 'g2'], { kind: 'verify', maxRetries: 0 }),
    ]);

    await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      runTentacleFn,
      worldModelGate: false,
    }).execute(graph);

    expect(cwds['v1']).toBeUndefined();
  });
});

describe('rolling admission', () => {
  const ok = (opts: RunTentacleOptions): TentacleResult => ({
    ok: true,
    agent: opts.agent,
    thoroughness: opts.thoroughness,
    model: 'test-model',
    result: 'done',
    footer: '',
    worktreePath: null,
    worktreeHandle: null,
  });

  it('starts a newly unblocked node without waiting for a slow one to finish', async () => {
    let slowInFlight = false;
    let startedWhileSlowRan = false;

    const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
      const id = opts.nodeId ?? '';
      if (id === 'g-slow') {
        slowInFlight = true;
        await new Promise((r) => setTimeout(r, 60));
        slowInFlight = false;
        return ok(opts);
      }
      if (id === 'g-after') {
        // This node only became ready when e1 finished. Under a wave-at-a-time
        // scheduler it could not start until g-slow had also finished.
        startedWhileSlowRan = slowInFlight;
        return ok(opts);
      }
      await new Promise((r) => setTimeout(r, 5));
      return ok(opts);
    };

    const graph = createGraph('rolling', [
      node('g-slow', [], { kind: 'general', scope: ['src/slow'], maxRetries: 0 }),
      node('e1', [], { kind: 'explore', maxRetries: 0 }),
      node('g-after', ['e1'], { kind: 'general', scope: ['src/after'], maxRetries: 0 }),
    ]);

    const summary = await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      runTentacleFn,
      worldModelGate: false,
    }).execute(graph);

    expect(summary.converged).toBe(true);
    expect(startedWhileSlowRan).toBe(true);
  });

  it('never exceeds the concurrency cap', async () => {
    let inFlight = 0;
    let peak = 0;

    const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return ok(opts);
    };

    const graph = createGraph('cap', [
      node('g1', [], { kind: 'general', scope: ['src/a'], maxRetries: 0 }),
      node('g2', [], { kind: 'general', scope: ['src/b'], maxRetries: 0 }),
      node('g3', [], { kind: 'general', scope: ['src/c'], maxRetries: 0 }),
      node('g4', [], { kind: 'general', scope: ['src/d'], maxRetries: 0 }),
    ]);

    const summary = await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      runTentacleFn,
      maxParallel: 2,
      worldModelGate: false,
    }).execute(graph);

    expect(summary.converged).toBe(true);
    expect(peak).toBe(2);
  });

  it('still refuses to overlap writers whose scopes are not provably disjoint', async () => {
    let inFlight = 0;
    let peak = 0;

    const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return ok(opts);
    };

    const graph = createGraph('overlap', [
      node('g1', [], { kind: 'general', scope: ['src/a'], maxRetries: 0 }),
      node('g2', [], { kind: 'general', scope: ['src/a/deep'], maxRetries: 0 }),
      node('g3', [], { kind: 'general', maxRetries: 0 }),
    ]);

    await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      runTentacleFn,
      worldModelGate: false,
    }).execute(graph);

    expect(peak).toBe(1);
  });

  it('turns an unexpected throw into a node failure instead of aborting the graph', async () => {
    const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
      if (opts.nodeId === 'boom') throw new Error('kaboom');
      return ok(opts);
    };

    const graph = createGraph('throwing', [
      node('boom', [], { kind: 'general', scope: ['src/a'], maxRetries: 0 }),
      node('fine', [], { kind: 'general', scope: ['src/b'], maxRetries: 0 }),
    ]);

    const summary = await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      runTentacleFn,
      fixBudget: 0,
      worldModelGate: false,
    }).execute(graph);

    expect(summary.converged).toBe(false);
    expect(summary.failedNodeIds).toEqual(['boom']);
    expect(graph.nodes.get('boom')?.error).toContain('kaboom');
    // the independent branch is unaffected
    expect(graph.nodes.get('fine')?.status).toBe('done');
  });
});

describe('graph cancellation', () => {
  const okResult = (opts: RunTentacleOptions): TentacleResult => ({
    ok: true,
    agent: opts.agent,
    thoroughness: opts.thoroughness,
    model: 'test-model',
    result: 'done',
    footer: '',
    worktreePath: null,
    worktreeHandle: null,
  });

  it('stops a running graph, settles it, and reports cancelled', async () => {
    const controller = new AbortController();
    const started: string[] = [];

    const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
      started.push(opts.nodeId ?? '?');
      if (opts.nodeId === 'g1') {
        // Cancel while this one is in flight, and unwind when told to.
        controller.abort();
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) return resolve();
          opts.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return { ok: false, agent: opts.agent, error: 'cancelled', cancelled: true };
      }
      return okResult(opts);
    };

    const graph = createGraph('cancel', [
      node('g1', [], { kind: 'general', label: 'slow', maxRetries: 2 }),
      node('v1', ['g1'], { kind: 'verify', maxRetries: 0 }),
      node('later', ['v1'], { kind: 'general', maxRetries: 0 }),
    ]);

    const summary = await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      runTentacleFn,
      signal: controller.signal,
      fixBudget: 2,
      worldModelGate: false,
    }).execute(graph);

    expect(summary.cancelled).toBe(true);
    expect(summary.converged).toBe(false);
    // the in-flight node ends as an error, NOT retried and NOT repaired
    expect(graph.nodes.get('g1')?.status).toBe('error');
    expect(graph.nodes.get('g1')?.retryCount).toBe(0);
    expect([...graph.nodes.values()].some((n) => n.kind === 'fix')).toBe(false);
    // nodes that never started are skipped, so the graph settles
    expect(graph.nodes.get('v1')?.status).toBe('skipped');
    expect(graph.nodes.get('later')?.status).toBe('skipped');
    expect(started).toEqual(['g1']);
  });

  it('runs nothing at all when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const started: string[] = [];

    const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
      started.push(opts.nodeId ?? '?');
      return okResult(opts);
    };

    const graph = createGraph('pre-cancelled', [
      node('g1', [], { kind: 'general', maxRetries: 0 }),
    ]);

    const summary = await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      runTentacleFn,
      signal: controller.signal,
      worldModelGate: false,
    }).execute(graph);

    expect(started).toEqual([]);
    expect(summary.cancelled).toBe(true);
    expect(summary.converged).toBe(false);
    expect(graph.nodes.get('g1')?.status).toBe('skipped');
  });

  it('reports cancelled=false and per-node durations for a normal run', async () => {
    const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
      await new Promise((r) => setTimeout(r, 5));
      return okResult(opts);
    };

    const graph = createGraph('timed', [
      node('g1', [], { kind: 'general', maxRetries: 0 }),
    ]);

    const summary = await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      runTentacleFn,
      worldModelGate: false,
    }).execute(graph);

    expect(summary.cancelled).toBe(false);
    expect(summary.converged).toBe(true);
    expect(summary.durationsMs['g1']).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Verify quality gate: a verify that RAN is not the same as work that PASSED.
// ─────────────────────────────────────────────────────────────────────────────

describe('verify verdict gate', () => {
  /** A tentacle runner whose verify nodes return a scripted verdict. */
  function scripted(
    verdictFor: (nodeId: string) => string,
    onCall?: (opts: RunTentacleOptions) => void,
  ) {
    return async (opts: RunTentacleOptions): Promise<TentacleResult> => {
      onCall?.(opts);
      const id = opts.nodeId ?? '?';
      return {
        ok: true,
        agent: opts.agent,
        thoroughness: opts.thoroughness,
        model: 'test-model',
        result: opts.agent === 'verify' ? verdictFor(id) : `${id}: wrote the code`,
        footer: '',
        worktreePath: null,
        worktreeHandle: null,
      };
    };
  }

  const plan = (id = 'gate'): ReturnType<typeof buildGraphFromPlan> =>
    buildGraphFromPlan(id, [
      { id: 'g1', kind: 'general', label: 'the work', prompt: 'do the work', deps: [] },
    ]);

  it('leaves the graph untouched when the verify passes', async () => {
    const graph = plan('pass');
    const before = graph.nodes.size;

    const summary = await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      runTentacleFn: scripted(() => 'checked it\n\nVERDICT: PASS'),
      worldModelGate: false,
    }).execute(graph);

    expect(graph.nodes.size).toBe(before);
    expect(summary.converged).toBe(true);
    expect(summary.unresolvedFindings).toEqual([]);
  });

  it('spawns a rework + fresh verify when the verify fails', async () => {
    const graph = plan('fail-then-pass');
    const seen: string[] = [];

    const summary = await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      runTentacleFn: scripted(
        (id) =>
          id === 'verify-g1'
            ? 'the error path is not handled\n\nVERDICT: FAIL'
            : 'now correct\n\nVERDICT: PASS',
        (opts) => seen.push(opts.nodeId ?? '?'),
      ),
      worldModelGate: false,
    }).execute(graph);

    const rework = graph.nodes.get('rework-g1-1');
    expect(rework).toBeDefined();
    expect(rework?.kind).toBe('fix');
    expect(rework?.deps).toEqual(['verify-g1']);
    // The rework must carry the reviewer's findings, or it redoes the work blind.
    expect(rework?.prompt).toContain('the error path is not handled');
    expect(rework?.prompt).toContain('do the work');

    const reVerify = graph.nodes.get('verify-rework-g1-1');
    expect(reVerify?.kind).toBe('verify');
    expect(reVerify?.deps).toEqual(['rework-g1-1']);

    expect(seen).toContain('rework-g1-1');
    expect(seen).toContain('verify-rework-g1-1');
    expect(summary.converged).toBe(true);
    expect(summary.unresolvedFindings).toEqual([]);
  });

  it('inherits the writer scope and acceptance into the rework', async () => {
    const graph = buildGraphFromPlan('inherit', [
      {
        id: 'g1',
        kind: 'general',
        label: 'scoped work',
        prompt: 'do it',
        deps: [],
        scope: ['src/a'],
        acceptance: ['exports foo()'],
      },
    ]);

    await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      runTentacleFn: scripted((id) =>
        id === 'verify-g1' ? 'nope\n\nVERDICT: FAIL' : 'ok\n\nVERDICT: PASS',
      ),
      worldModelGate: false,
    }).execute(graph);

    const rework = graph.nodes.get('rework-g1-1');
    expect(rework?.scope).toEqual(['src/a']);
    expect(rework?.acceptance).toEqual(['exports foo()']);
  });

  it('repoints the merge node at the fresh verify so it cannot merge mid-rework', async () => {
    const graph = buildGraphFromPlan('merge-repoint', [
      { id: 'g1', kind: 'general', label: 'a', prompt: 'a', deps: [], scope: ['src/a'] },
      { id: 'g2', kind: 'general', label: 'b', prompt: 'b', deps: [], scope: ['src/b'] },
    ]);

    await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      runTentacleFn: scripted((id) =>
        id === 'verify-g1' ? 'bad\n\nVERDICT: FAIL' : 'good\n\nVERDICT: PASS',
      ),
      mergeFn: async () => ({ ok: true, merged: true, committed: true, message: 'ok' }),
      worldModelGate: false,
    }).execute(graph);

    const merge = [...graph.nodes.values()].find((n) => n.kind === 'merge');
    expect(merge?.deps).toContain('verify-rework-g1-1');
    expect(merge?.deps).not.toContain('verify-g1');
    // The untouched branch keeps its original verify.
    expect(merge?.deps).toContain('verify-g2');
  });

  it('runs the rework inside the writer worktree and does NOT open a second one', async () => {
    // The regression this guards: a rework on its own branch is merged never or
    // twice, stranding that round's work.
    const calls: Array<{
      id: string;
      cwd?: string;
      allowWorktree?: boolean;
      deferMerge?: boolean;
    }> = [];

    const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
      calls.push({
        id: opts.nodeId ?? '?',
        cwd: opts.cwdOverride,
        allowWorktree: (opts.deps as { allowWorktree?: boolean }).allowWorktree,
        deferMerge: opts.deferMerge,
      });
      const isWriter = opts.agent === 'general' && !opts.nodeId?.startsWith('rework-');
      const verifyText =
        opts.nodeId === 'verify-g1'
          ? 'bad\n\nVERDICT: FAIL'
          : 'good\n\nVERDICT: PASS';
      return {
        ok: true,
        agent: opts.agent,
        thoroughness: opts.thoroughness,
        model: 'test-model',
        result: opts.agent === 'verify' ? verifyText : 'wrote it',
        footer: '',
        worktreePath: isWriter ? fakeWorktreeHandle(opts.nodeId ?? 'x').path : null,
        worktreeHandle: isWriter ? fakeWorktreeHandle(opts.nodeId ?? 'x') : null,
      };
    };

    const graph = plan('rework-wt');
    await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      runTentacleFn,
      worldModelGate: false,
    }).execute(graph);

    const rework = calls.find((c) => c.id === 'rework-g1-1');
    expect(rework?.cwd).toBe(fakeWorktreeHandle('g1').path);
    expect(rework?.allowWorktree).toBe(false);
    // No worktree of its own -> nothing to defer-merge.
    expect(rework?.deferMerge).toBe(false);
    // The fresh verify inspects the same tree.
    expect(calls.find((c) => c.id === 'verify-rework-g1-1')?.cwd).toBe(
      fakeWorktreeHandle('g1').path,
    );
  });

  it('accepts the work degraded once the rework budget is spent', async () => {
    const graph = plan('budget');

    const summary = await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      // Every verify rejects, forever.
      runTentacleFn: scripted(() => 'still broken\n\nVERDICT: FAIL'),
      maxReviewRounds: 1,
      worldModelGate: false,
    }).execute(graph);

    // Exactly one rework round, not an unbounded loop.
    expect(graph.nodes.get('rework-g1-1')).toBeDefined();
    expect(graph.nodes.get('rework-g1-2')).toBeUndefined();
    // Degraded convergence: the work exists, with the verdict attached to it.
    expect(summary.converged).toBe(true);
    expect(summary.unresolvedFindings).toHaveLength(1);
    expect(summary.unresolvedFindings[0].reason).toBe('fail');
    expect(summary.unresolvedFindings[0].findings).toContain('still broken');
    expect(graph.nodes.get('rework-g1-1')?.result).toContain('unresolved verify findings');
  });

  it('honours maxReviewRounds > 1', async () => {
    const graph = plan('two-rounds');

    await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      runTentacleFn: scripted(() => 'nope\n\nVERDICT: FAIL'),
      maxReviewRounds: 2,
      worldModelGate: false,
    }).execute(graph);

    // Rounds are counted per lineage, not per node: the second round reworks
    // the first rework but is still named (and budgeted) against g1. Counting
    // per node reset the budget every round and chained reworks forever.
    expect(graph.nodes.get('rework-g1-1')).toBeDefined();
    expect(graph.nodes.get('rework-g1-2')).toBeDefined();
    expect(graph.nodes.get('rework-g1-3')).toBeUndefined();
  });

  it('treats a missing verdict as non-blocking but reports it', async () => {
    const graph = plan('no-trailer');

    const summary = await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      runTentacleFn: scripted(() => 'I looked at it and it seems fine'),
      worldModelGate: false,
    }).execute(graph);

    expect(graph.nodes.get('rework-g1-1')).toBeUndefined();
    expect(summary.converged).toBe(true);
    expect(summary.unresolvedFindings).toHaveLength(1);
    expect(summary.unresolvedFindings[0].reason).toBe('unknown');
  });

  it('does not spend the fix budget on rework rounds', async () => {
    // A rejected-but-working node and a genuinely failing one: the failure must
    // still get its repair even though a rework happened first.
    const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
      const id = opts.nodeId ?? '?';
      if (id === 'bad') {
        return { ok: false, agent: opts.agent, error: 'bad always fails' };
      }
      const verifyText =
        id === 'verify-g1' ? 'reject\n\nVERDICT: FAIL' : 'ok\n\nVERDICT: PASS';
      return {
        ok: true,
        agent: opts.agent,
        thoroughness: opts.thoroughness,
        model: 'test-model',
        result: opts.agent === 'verify' ? verifyText : 'wrote it',
        footer: '',
        worktreePath: null,
        worktreeHandle: null,
      };
    };

    const graph = buildGraphFromPlan('budget-split', [
      {
        id: 'g1',
        kind: 'general',
        label: 'rejected work',
        prompt: 'a',
        deps: [],
        scope: ['src/a'],
      },
      { id: 'bad', kind: 'general', label: 'bad', prompt: 'b', deps: [], scope: ['src/b'] },
    ]);

    await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      runTentacleFn,
      fixBudget: 1,
      maxReviewRounds: 1,
      mergeFn: async () => ({ ok: true, merged: true, committed: true, message: 'ok' }),
      worldModelGate: false,
    }).execute(graph);

    // The rework happened...
    expect(graph.nodes.get('rework-g1-1')).toBeDefined();
    // ...and the unrelated failure still got its (separately budgeted) fix node.
    expect([...graph.nodes.keys()].some((k) => k.startsWith('fix-bad-'))).toBe(true);
  });

  it('does not spawn a rework once the run is cancelled', async () => {
    const controller = new AbortController();
    const graph = plan('cancelled');

    const summary = await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      runTentacleFn: async (opts) => {
        if (opts.agent === 'verify') controller.abort();
        return {
          ok: true,
          agent: opts.agent,
          thoroughness: opts.thoroughness,
          model: 'test-model',
          result: opts.agent === 'verify' ? 'no good\n\nVERDICT: FAIL' : 'wrote it',
          footer: '',
          worktreePath: null,
          worktreeHandle: null,
        };
      },
      signal: controller.signal,
      worldModelGate: false,
    }).execute(graph);

    expect(graph.nodes.get('rework-g1-1')).toBeUndefined();
    expect(summary.cancelled).toBe(true);
    // The verdict is still surfaced rather than lost with the cancellation.
    expect(summary.unresolvedFindings).toHaveLength(1);
  });
});

describe('fix budget scales with graph size', () => {
  it('keeps 3 as the floor for a small graph', () => {
    expect(resolveFixBudget({}, 0)).toBe(3);
    expect(resolveFixBudget({}, 4)).toBe(3);
  });

  it('scales with the node count for a large graph', () => {
    // A flat 3 meant the bigger the graph, the less repair it got.
    expect(resolveFixBudget({}, 20)).toBe(10);
    expect(resolveFixBudget({}, 7)).toBe(4);
  });

  it('lets an explicit env value win outright', () => {
    expect(resolveFixBudget({ ZELARI_KRAKEN_FIX_BUDGET: '1' }, 20)).toBe(1);
    expect(resolveFixBudget({ ZELARI_KRAKEN_FIX_BUDGET: '0' }, 20)).toBe(0);
    // Garbage falls back to the scaled default, not to the garbage.
    expect(resolveFixBudget({ ZELARI_KRAKEN_FIX_BUDGET: 'nope' }, 20)).toBe(10);
  });
});

describe('whole-graph wall-clock budget', () => {
  it('is disabled by default', () => {
    expect(resolveGraphTimeoutMs({})).toBe(0);
    expect(resolveMaxReviewRounds({})).toBe(1);
  });

  it('reads its env overrides', () => {
    expect(resolveGraphTimeoutMs({ ZELARI_KRAKEN_GRAPH_TIMEOUT_MS: '5000' })).toBe(5000);
    expect(resolveGraphTimeoutMs({ ZELARI_KRAKEN_GRAPH_TIMEOUT_MS: 'x' })).toBe(0);
    expect(resolveMaxReviewRounds({ ZELARI_KRAKEN_MAX_REVIEW_ROUNDS: '3' })).toBe(3);
    expect(resolveMaxReviewRounds({ ZELARI_KRAKEN_MAX_REVIEW_ROUNDS: '0' })).toBe(0);
  });

  it('cancels a run that outlives its budget, and still returns a summary', async () => {
    const graph = createGraph('slow', [
      node('g1', [], { kind: 'general', maxRetries: 0 }),
      node('g2', ['g1'], { kind: 'general', maxRetries: 0 }),
    ]);

    const summary = await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'test-session',
      runTentacleFn: async (opts) => {
        await new Promise((r) => setTimeout(r, 60));
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
      },
      graphTimeoutMs: 20,
      cancelGraceMs: 10,
      worldModelGate: false,
    }).execute(graph);

    expect(summary.cancelled).toBe(true);
    expect(summary.converged).toBe(false);
    // The point of routing through the cancellation path: it still settles.
    expect(graph.nodes.get('g2')?.status).toBe('skipped');
  });
});

describe('KrakenGraphExecutor transactional writers (P2.D)', () => {
  let repo: string;

  beforeEach(() => {
    resetKrakenGraphLive();
    repo = mkdtempSync(path.join(tmpdir(), 'tx-exec-'));
    const run = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
    run('init');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'Test');
    run('config', 'commit.gpgsign', 'false');
    // Byte-exact restores on Windows (mirrors cli-checkpoint.test.ts).
    run('config', 'core.autocrlf', 'false');
    // Keep tool state (.zelari/radio, workbench) out of the checkpoints, the
    // way production repos ignore it — the transaction covers the WORK TREE.
    writeFileSync(path.join(repo, '.gitignore'), '.zelari/\n');
    writeFileSync(path.join(repo, 'seed.txt'), 'original\n');
    execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repo, 'commit', '-m', 'initial'], { stdio: 'ignore' });
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const okResult = (opts: RunTentacleOptions): TentacleResult => ({
    ok: true,
    agent: opts.agent,
    thoroughness: opts.thoroughness,
    model: 'test-model',
    result: 'done',
    footer: '',
    worktreePath: null,
    worktreeHandle: null,
  });

  it('rolls the workspace back when a transactional writer node fails', async () => {
    const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
      // Partial work: a new file plus a mutation of a tracked one.
      writeFileSync(path.join(repo, 'dirty.txt'), 'partial work\n');
      writeFileSync(path.join(repo, 'seed.txt'), 'MUTATED\n');
      return { ok: false, agent: opts.agent, error: 'writer gave up', cancelled: true };
    };

    const graph = createGraph('tx-fail', [node('g1', [], { kind: 'general', maxRetries: 0 })]);

    const summary = await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: repo,
      sessionId: 'tx-fail',
      runTentacleFn,
      worldModelGate: false,
      fixBudget: 0,
      transactional: true,
    }).execute(graph);

    // The node went through the ordinary failure path…
    expect(summary.failedNodeIds).toEqual(['g1']);
    expect(graph.nodes.get('g1')?.status).toBe('error');
    // …and the workspace is back at the pre-run checkpoint state.
    expect(existsSync(path.join(repo, 'dirty.txt'))).toBe(false);
    expect(readFileSync(path.join(repo, 'seed.txt'), 'utf8')).toBe('original\n');
    // The rollback is surfaced on the radio.
    const events = readKrakenRadio(repo, 'tx-fail');
    expect(events.some((e) => e.kind === 'node_rolled_back' && e.ok === false)).toBe(true);
  });

  it('keeps a node-correlated recovery-point checkpoint when the writer succeeds', async () => {
    const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
      writeFileSync(path.join(repo, 'out.txt'), 'work\n');
      return okResult(opts);
    };

    const graph = createGraph('tx-ok', [node('g1', [], { kind: 'general', maxRetries: 0 })]);

    const summary = await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: repo,
      sessionId: 'tx-ok',
      runTentacleFn,
      worldModelGate: false,
      transactional: true,
    }).execute(graph);

    expect(summary.converged).toBe(true);
    // Success keeps the work…
    expect(readFileSync(path.join(repo, 'out.txt'), 'utf8')).toBe('work\n');
    // …and the recovery point, correlated to the graph (task) and node.
    const cps = await listCheckpoints(repo);
    expect(cps).toHaveLength(1);
    expect(cps[0].label).toContain('task=tx-ok');
    expect(cps[0].label).toContain('node=g1');
  });

  it('stays inert when transactional is off (default): partial work is left in place', async () => {
    const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
      writeFileSync(path.join(repo, 'dirty.txt'), 'partial work\n');
      return { ok: false, agent: opts.agent, error: 'writer gave up', cancelled: true };
    };

    const graph = createGraph('tx-off', [node('g1', [], { kind: 'general', maxRetries: 0 })]);

    await new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: repo,
      sessionId: 'tx-off',
      runTentacleFn,
      worldModelGate: false,
      fixBudget: 0,
    }).execute(graph);

    // No checkpoint taken, nothing rolled back — pre-P2.D behavior exactly.
    expect(existsSync(path.join(repo, 'dirty.txt'))).toBe(true);
    expect(await listCheckpoints(repo)).toHaveLength(0);
  });
});

describe('P2.B semantic ownership (ownedSymbols)', () => {
  const ENV_KEY = 'ZELARI_KRAKEN_WORKTREE';
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
  });

  /** Runner counting concurrency; every run succeeds. */
  function makeRunner() {
    let inFlight = 0;
    const state = { peakInFlight: 0 };
    const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
      inFlight += 1;
      state.peakInFlight = Math.max(state.peakInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
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
    return { runTentacleFn, state };
  }

  /**
   * Two same-file writers. The scopes are case-distinct so core's
   * case-sensitive `canRunParallel` lets both become candidates, while the
   * executor's folded arbitration (win32 default) defers the second — the
   * deferral the semantic rescue then re-examines.
   */
  function sameFilePair(symbolsG1: string[] | undefined, symbolsG2: string[] | undefined) {
    return createGraph('sem-own', [
      node('g1', [], {
        kind: 'general',
        scope: ['SRC/auth.ts'],
        ...(symbolsG1 === undefined ? {} : { ownedSymbols: symbolsG1 }),
        maxRetries: 0,
      }),
      node('g2', [], {
        kind: 'general',
        scope: ['src/auth.ts'],
        ...(symbolsG2 === undefined ? {} : { ownedSymbols: symbolsG2 }),
        maxRetries: 0,
      }),
    ]);
  }

  const verifyingExtractor = async (file: string): Promise<readonly string[] | null> => {
    if (!file.endsWith('.ts')) return null;
    return ['AuthService', 'TokenService'];
  };

  it('auto: disjoint same-file symbols are admitted in parallel (worktree-style rescue)', async () => {
    process.env[ENV_KEY] = 'auto';
    const { runTentacleFn, state } = makeRunner();
    const executor = new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'sem-auto-disjoint',
      runTentacleFn,
      worldModelGate: false,
      ownershipCaseFolding: true,
      symbolExtractor: verifyingExtractor,
    });

    const summary = await executor.execute(
      sameFilePair(['src/auth.ts#AuthService.login'], ['src/auth.ts#TokenService.refresh']),
    );
    expect(summary.converged).toBe(true);
    expect(state.peakInFlight).toBe(2);
    const events = readKrakenRadio('/tmp/repo', 'sem-auto-disjoint');
    const evt = events.find((e) => e.kind === 'node_semantic_admitted');
    expect(evt).toBeDefined();
    expect(evt?.nodeId).toBe('g2');
    expect(evt?.runningNode).toBe('g1');
    expect(evt?.contestedFile).toBe('src/auth.ts');
    expect(evt?.symbolsA).toEqual(['src/auth.ts#AuthService.login']);
    expect(evt?.symbolsB).toEqual(['src/auth.ts#TokenService.refresh']);
    expect(evt?.rationaleCode).toBe('semantic-disjoint-worktree');
    // g2 never went through the plain deferral path.
    expect(events.some((e) => e.kind === 'node_deferred' && e.description === 'g2')).toBe(false);
  });

  it('auto: the same declared symbol still defers exactly as t25 left it', async () => {
    process.env[ENV_KEY] = 'auto';
    const { runTentacleFn, state } = makeRunner();
    const executor = new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'sem-auto-clash',
      runTentacleFn,
      worldModelGate: false,
      ownershipCaseFolding: true,
      symbolExtractor: verifyingExtractor,
    });

    await executor.execute(
      sameFilePair(['src/auth.ts#AuthService.login'], ['src/auth.ts#AuthService.login']),
    );
    expect(state.peakInFlight).toBe(1);
    const events = readKrakenRadio('/tmp/repo', 'sem-auto-clash');
    expect(events.some((e) => e.kind === 'node_deferred' && e.description === 'g2')).toBe(true);
    expect(events.some((e) => e.kind === 'node_semantic_admitted')).toBe(false);
  });

  it('without ownedSymbols nothing changes: deferral, no semantic events', async () => {
    const { runTentacleFn, state } = makeRunner();
    const executor = new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'sem-undeclared',
      runTentacleFn,
      worldModelGate: false,
      ownershipCaseFolding: true,
      symbolExtractor: verifyingExtractor,
    });

    await executor.execute(sameFilePair(undefined, undefined));
    expect(state.peakInFlight).toBe(1);
    const events = readKrakenRadio('/tmp/repo', 'sem-undeclared');
    expect(events.some((e) => e.kind === 'node_deferred' && e.description === 'g2')).toBe(true);
    expect(events.some((e) => e.kind === 'node_semantic_admitted')).toBe(false);
  });

  it('a throwing extractor defers (fail-closed, never fail-open)', async () => {
    process.env[ENV_KEY] = 'auto';
    const { runTentacleFn, state } = makeRunner();
    const executor = new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'sem-extractor-throw',
      runTentacleFn,
      worldModelGate: false,
      ownershipCaseFolding: true,
      symbolExtractor: async () => {
        throw new Error('ast engine exploded');
      },
    });

    await executor.execute(
      sameFilePair(['src/auth.ts#AuthService.login'], ['src/auth.ts#TokenService.refresh']),
    );
    expect(state.peakInFlight).toBe(1);
    const events = readKrakenRadio('/tmp/repo', 'sem-extractor-throw');
    expect(events.some((e) => e.kind === 'node_deferred' && e.description === 'g2')).toBe(true);
    expect(events.some((e) => e.kind === 'node_semantic_admitted')).toBe(false);
  });

  it('worktree off: disjoint same-file symbols admit plainly with telemetry', async () => {
    const { runTentacleFn, state } = makeRunner();
    const executor = new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'sem-plain',
      runTentacleFn,
      worldModelGate: false,
      ownershipCaseFolding: true,
      symbolExtractor: verifyingExtractor,
    });

    await executor.execute(
      sameFilePair(['src/auth.ts#AuthService.login'], ['src/auth.ts#TokenService.refresh']),
    );
    expect(state.peakInFlight).toBe(2);
    const events = readKrakenRadio('/tmp/repo', 'sem-plain');
    const evt = events.find((e) => e.kind === 'node_semantic_admitted');
    expect(evt).toBeDefined();
    expect(evt?.rationaleCode).toBe('semantic-disjoint-plain');
    expect(evt?.contestedFile).toBe('src/auth.ts');
  });
});

/**
 * t29 (§15): reputation recording — one JSONL row per settled node, keyed by
 * (repo, role, model), written next to the run; and FAILOPEN: a store that
 * cannot be written (unusable path) must never fail the run.
 */
describe('reputation recording (t29)', () => {
  let tmp: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'zelari-rep-'));
    prevEnv = process.env.ZELARI_REPUTATION_PATH;
    resetKrakenGraphLive();
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.ZELARI_REPUTATION_PATH;
    else process.env.ZELARI_REPUTATION_PATH = prevEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  const runTentacleFn = async (opts: RunTentacleOptions): Promise<TentacleResult> => {
    const isVerify = opts.agent === 'verify';
    return {
      ok: true,
      agent: opts.agent,
      thoroughness: opts.thoroughness,
      model: isVerify ? 'verify-model' : 'writer-model',
      result: isVerify ? 'checked it\n\nVERDICT: PASS' : 'done',
      footer: '',
      worktreePath: null,
      worktreeHandle: null,
      usage: { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000, cachedPromptTokens: 0 },
    };
  };

  it('records one line per settled node with repo/role/model/outcome/cost/latency', async () => {
    const storePath = path.join(tmp, 'reputation.jsonl');
    process.env.ZELARI_REPUTATION_PATH = storePath;

    const graph = createGraph('rep-recording', [
      node('w', [], { kind: 'general', label: 'w' }),
      node('v', ['w'], { kind: 'verify', label: 'v' }),
    ]);
    const executor = new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: tmp,
      sessionId: 'rep-session',
      runTentacleFn,
      worldModelGate: false,
    });
    const summary = await executor.execute(graph);
    expect(summary.converged).toBe(true);

    const lines = readFileSync(storePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const records = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const writer = records.find((r) => r['role'] === 'general')!;
    const verify = records.find((r) => r['role'] === 'verify')!;
    expect(writer['repo']).toBe(path.basename(tmp));
    expect(writer['model']).toBe('writer-model');
    expect(writer['provider']).toBeNull();
    expect(writer['outcome']).toBe('verified');
    expect(writer['firstPass']).toBe(true);
    // 1M in + 1M out at DEFAULT_RATE (input $1/M, output $3/M) = $4.
    expect(writer['costUsd']).toBeCloseTo(4, 5);
    expect(typeof writer['latencyMs']).toBe('number');
    expect(verify['model']).toBe('verify-model');
    expect(verify['outcome']).toBe('verified'); // VERDICT: PASS trailer
  });

  it('is fail-open: an unwritable store never breaks the run', async () => {
    // A regular FILE where mkdir would need a directory ⇒ append always fails
    // (ENOTDIR/EEXIST), deterministically on win32 and POSIX alike.
    const blocker = path.join(tmp, 'blocker');
    writeFileSync(blocker, 'not a directory', 'utf8');
    process.env.ZELARI_REPUTATION_PATH = path.join(blocker, 'reputation.jsonl');

    const graph = createGraph('rep-failopen', [
      node('w', [], { kind: 'general', label: 'w' }),
      node('v', ['w'], { kind: 'verify', label: 'v' }),
    ]);
    const executor = new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: tmp,
      sessionId: 'rep-failopen-session',
      runTentacleFn,
      worldModelGate: false,
    });
    const summary = await executor.execute(graph);
    expect(summary.converged).toBe(true);
    expect(graph.nodes.get('w')?.status).toBe('done');
    expect(graph.nodes.get('v')?.status).toBe('done');
    expect(existsSync(process.env.ZELARI_REPUTATION_PATH!)).toBe(false);
  });
});

describe('spawn ROI gate (P2.F)', () => {
  const ENV_KEY = 'ZELARI_KRAKEN_ROI_THRESHOLD';
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    resetKrakenGraphLive();
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
  });

  const okRunner =
    (onRun: () => void = () => {}) =>
    async (opts: RunTentacleOptions): Promise<TentacleResult> => {
      onRun();
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

  function singleWriter() {
    return createGraph('roi-one', [
      node('w', [], { kind: 'general', label: 'w', scope: ['src/roi-a'], maxRetries: 0 }),
    ]);
  }

  it('(a) healthy node spawns: no veto radio, node runs, run converges', async () => {
    let ran = 0;
    const executor = new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'roi-healthy',
      runTentacleFn: okRunner(() => {
        ran += 1;
      }),
      worldModelGate: false,
      reputationRecords: [], // no history ⇒ all-null score ⇒ spawn (fail-open)
    });
    const graph = singleWriter();
    const summary = await executor.execute(graph);

    expect(summary.converged).toBe(true);
    expect(ran).toBe(1);
    expect(graph.nodes.get('w')?.status).toBe('done');
    expect(
      readKrakenRadio('/tmp/repo', 'roi-healthy').some((e) => e.kind === 'node_roi_vetoed'),
    ).toBe(false);
  });

  it('(b) very high threshold env: veto radio + node deferred (never failed) + run completes', async () => {
    process.env[ENV_KEY] = '999';
    let ran = 0;
    const executor = new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'roi-veto-high',
      runTentacleFn: okRunner(() => {
        ran += 1;
      }),
      worldModelGate: false,
      reputationRecords: [],
    });
    const graph = singleWriter();
    const summary = await executor.execute(graph);

    expect(ran).toBe(0); // the spawn never happened
    expect(graph.nodes.get('w')?.status).toBe('pending'); // deferred path, not failed
    expect(summary.failedNodeIds).toEqual([]);
    const evt = readKrakenRadio('/tmp/repo', 'roi-veto-high').find(
      (e) => e.kind === 'node_roi_vetoed',
    );
    expect(evt).toBeDefined();
    expect(evt?.nodeId).toBe('w');
    expect(evt?.threshold).toBe(999);
    expect(typeof evt?.spawnScore).toBe('number');
    expect(evt?.rationaleCode).toBe('roi-defaults');
    // A ROI veto is not an ownership deferral: no node_deferred event.
    expect(
      readKrakenRadio('/tmp/repo', 'roi-veto-high').some((e) => e.kind === 'node_deferred'),
    ).toBe(false);
  });

  it('(b2) reputation-backed: a failing (repo, role) bucket vetoes with no env override', async () => {
    const now = Date.now();
    const records: ReputationRecord[] = Array.from({ length: 6 }, () => ({
      ts: now - 60_000,
      repo: 'repo', // basename of parentCwd '/tmp/repo'
      model: 'm',
      provider: null,
      role: 'general', // agentForNode(general) parity
      language: null,
      outcome: 'failed',
      firstPass: false,
      repairCount: 3,
      costUsd: null,
      latencyMs: null,
    }));
    let ran = 0;
    const executor = new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'roi-veto-reputation',
      runTentacleFn: okRunner(() => {
        ran += 1;
      }),
      worldModelGate: false,
      reputationRecords: records,
    });
    const graph = singleWriter();
    const summary = await executor.execute(graph);

    expect(ran).toBe(0);
    expect(graph.nodes.get('w')?.status).toBe('pending');
    expect(summary.failedNodeIds).toEqual([]);
    const evt = readKrakenRadio('/tmp/repo', 'roi-veto-reputation').find(
      (e) => e.kind === 'node_roi_vetoed',
    );
    expect(evt).toBeDefined();
    expect(evt?.rationaleCode).toBe('roi-reputation-backed');
    expect(evt?.spawnScore).toBe(0); // verifiedRate 0 ⇒ gain 0
    expect(evt?.threshold).toBe(0.15); // untouched default
  });

  it('(c) fail-open: a throwing score seam never breaks the run', async () => {
    let ran = 0;
    const executor = new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'roi-failopen-score',
      runTentacleFn: okRunner(() => {
        ran += 1;
      }),
      worldModelGate: false,
      reputationRecords: [],
      roiScoreFn: () => {
        throw new Error('roi seam exploded');
      },
    });
    const graph = singleWriter();
    const summary = await executor.execute(graph);

    expect(summary.converged).toBe(true);
    expect(ran).toBe(1);
    expect(graph.nodes.get('w')?.status).toBe('done');
    expect(
      readKrakenRadio('/tmp/repo', 'roi-failopen-score').some(
        (e) => e.kind === 'node_roi_vetoed',
      ),
    ).toBe(false);
  });

  it('(c2) invalid threshold string falls back to the default (all-null ⇒ spawn)', async () => {
    process.env[ENV_KEY] = 'not-a-number';
    let ran = 0;
    const executor = new KrakenGraphExecutor({
      taskToolDeps: fakeTaskToolDeps,
      parentCwd: '/tmp/repo',
      sessionId: 'roi-bad-threshold',
      runTentacleFn: okRunner(() => {
        ran += 1;
      }),
      worldModelGate: false,
      reputationRecords: [],
    });
    const summary = await executor.execute(singleWriter());

    expect(summary.converged).toBe(true);
    expect(ran).toBe(1);
    expect(
      readKrakenRadio('/tmp/repo', 'roi-bad-threshold').some(
        (e) => e.kind === 'node_roi_vetoed',
      ),
    ).toBe(false);
  });
});
