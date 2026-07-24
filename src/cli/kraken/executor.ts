/**
 * KrakenGraphExecutor — F3: drives a TaskGraph to convergence.
 *
 * Consumes the pure primitives from `@zelari/core` (getReadyNodes,
 * selectParallelWave, isSettled/isConverged) and the F2 tentacle runner
 * (`runTentacle`) to execute a validated `TaskGraph`:
 *   - repeatedly forms a parallel-safe "wave" of ready nodes (bounded by
 *     ZELARI_KRAKEN_MAX_PARALLEL) and runs it concurrently;
 *   - retries a failed node up to `node.maxRetries`, then spawns a `fix`
 *     node (bounded by a global fix budget) that inherits the failed
 *     node's deps/scope/acceptance; a node that still fails is left
 *     terminally `error` and does NOT abort independent branches — nodes
 *     that transitively depend on it are cascade-marked `skipped` so the
 *     graph can still settle;
 *   - merges worktree-isolated `general`/`fix` tentacles SEQUENTIALLY when
 *     a `merge` node's deps complete (Correction 4 — no concurrent merges
 *     into the same parent HEAD); on conflict the branch/worktree is kept
 *     and surfaced, never auto-resolved;
 *   - optionally gates final convergence on `run_backtest` (Level 3) when
 *     `.zelari/world/checks.json` exists and ZELARI_SCHEMA_LOOP != '0'.
 *
 * Explicitly NOT this module's job (deferred to later phases):
 *   - planning a graph from a prompt (F4) or auto-injecting verify nodes —
 *     the executor only executes the graph it's given;
 *   - StatusBar / `/kraken graph` rendering (F5, beyond the radio events
 *     emitted here);
 *   - wiring into any slash command or `useChatTurn` (F6).
 *
 * @since v0.10.x — Kraken graph engine (F3)
 */

import {
  type TaskGraph,
  type TaskNode,
  getReadyNodes,
  isSettled,
  isConverged,
  failedNodeIds,
  countByStatus,
  selectParallelWave,
} from '@zelari/core';
import {
  runTentacle,
  type RunTentacleOptions,
  type TentacleResult,
  type TaskToolDeps,
} from './tentacle.js';
import {
  mergeKrakenWorktree,
  type WorktreeHandle,
  type WorktreeMergeResult,
} from '../tools/krakenWorktree.js';
import { appendKrakenRadio } from '../tools/krakenRadio.js';
import { runBacktest, type BacktestResult } from '../workspace/worldModel.js';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Default cap on concurrently-running tentacles across the whole graph. */
export const DEFAULT_MAX_PARALLEL = 12;

/** Default number of `fix` nodes the executor may spawn across one graph run. */
export const DEFAULT_FIX_BUDGET = 3;

export function resolveMaxParallel(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ZELARI_KRAKEN_MAX_PARALLEL;
  if (raw === undefined || raw === '') return DEFAULT_MAX_PARALLEL;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_PARALLEL;
}

export function resolveFixBudget(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ZELARI_KRAKEN_FIX_BUDGET;
  if (raw === undefined || raw === '') return DEFAULT_FIX_BUDGET;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_FIX_BUDGET;
}

/** Whether the optional Level-3 world-model convergence gate should run. */
export function isWorldModelGateEnabled(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  checksExists: (cwd: string) => boolean = defaultChecksExists,
): boolean {
  if ((env.ZELARI_SCHEMA_LOOP ?? '').trim() === '0') return false;
  return checksExists(cwd);
}

function defaultChecksExists(cwd: string): boolean {
  try {
    return existsSync(path.join(cwd, '.zelari', 'world', 'checks.json'));
  } catch {
    return false;
  }
}

export interface KrakenGraphExecutorOptions {
  taskToolDeps: TaskToolDeps;
  /** Parent working directory (the repo root the graph runs against). */
  parentCwd: string;
  /** Session id used for radio JSONL correlation. */
  sessionId: string;
  maxParallel?: number;
  fixBudget?: number;
  /** Force-enable/disable the Level-3 world-model gate (else auto-detected). */
  worldModelGate?: boolean;
  /** Injection points for tests — default to the real implementations. */
  runTentacleFn?: (opts: RunTentacleOptions) => Promise<TentacleResult>;
  mergeFn?: (
    handle: WorktreeHandle,
    opts?: { message?: string; cleanup?: boolean },
  ) => Promise<WorktreeMergeResult>;
  backtestFn?: (cwd: string) => Promise<BacktestResult>;
}

export interface KrakenExecutionSummary {
  graph: TaskGraph;
  converged: boolean;
  failedNodeIds: string[];
  counts: Record<string, number>;
  backtest?: BacktestResult;
}

/** One node's outcome, tracked internally for merge/fix bookkeeping. */
interface NodeRunState {
  worktreeHandle: WorktreeHandle | null;
}

export class KrakenGraphExecutor {
  private readonly deps: TaskToolDeps;
  private readonly parentCwd: string;
  private readonly sessionId: string;
  private readonly maxParallel: number;
  private fixBudgetRemaining: number;
  private readonly worldModelGateOverride: boolean | undefined;
  private readonly runTentacleFn: (opts: RunTentacleOptions) => Promise<TentacleResult>;
  private readonly mergeFn: (
    handle: WorktreeHandle,
    opts?: { message?: string; cleanup?: boolean },
  ) => Promise<WorktreeMergeResult>;
  private readonly backtestFn: (cwd: string) => Promise<BacktestResult>;

  private readonly nodeRunState = new Map<string, NodeRunState>();
  private fixCounter = 0;

  constructor(opts: KrakenGraphExecutorOptions) {
    this.deps = opts.taskToolDeps;
    this.parentCwd = opts.parentCwd;
    this.sessionId = opts.sessionId;
    this.maxParallel = opts.maxParallel ?? resolveMaxParallel();
    this.fixBudgetRemaining = opts.fixBudget ?? resolveFixBudget();
    this.worldModelGateOverride = opts.worldModelGate;
    this.runTentacleFn = opts.runTentacleFn ?? runTentacle;
    this.mergeFn = opts.mergeFn ?? mergeKrakenWorktree;
    this.backtestFn = opts.backtestFn ?? runBacktest;
  }

  /** Execute the graph in place (mutates node statuses) until it settles. */
  async execute(graph: TaskGraph): Promise<KrakenExecutionSummary> {
    // Anti-explosion / self-inflicted-hang guard: cap total loop iterations
    // at a generous multiple of the node count instead of trusting the
    // graph to always shrink monotonically (fix-node spawns grow it).
    const maxIterations = Math.max(64, graph.nodes.size * 8);
    let iterations = 0;

    while (!isSettled(graph)) {
      iterations += 1;
      if (iterations > maxIterations) {
        this.radio('graph_failed', {
          description: 'graph executor',
          detail: `exceeded ${maxIterations} scheduling iterations without settling`,
          ok: false,
        });
        break;
      }

      const ready = getReadyNodes(graph);
      if (ready.length === 0) {
        // Nothing is ready but the graph hasn't settled: some pending nodes
        // are permanently blocked by a failed/skipped dependency. Cascade
        // skip them so the loop can terminate.
        const skippedAny = this.skipBlockedNodes(graph);
        if (!skippedAny) {
          // Nothing ready and nothing to skip — should not happen for a
          // validated DAG, but bail out rather than spin forever.
          break;
        }
        continue;
      }

      const wave = selectParallelWave(ready).slice(0, this.maxParallel);
      for (const node of wave) node.status = 'running';

      const results = await Promise.all(wave.map((node) => this.runNode(node, graph)));
      for (let i = 0; i < wave.length; i++) {
        this.applyResult(graph, wave[i], results[i]);
      }
    }

    let backtest: BacktestResult | undefined;
    const converged = isConverged(graph);
    if (converged) {
      const gateOn =
        this.worldModelGateOverride ?? isWorldModelGateEnabled(this.parentCwd);
      if (gateOn) {
        backtest = await this.backtestFn(this.parentCwd);
      }
      this.radio('graph_converged', {
        description: 'graph executor',
        detail: backtest ? `backtest: ${backtest.passed}/${backtest.total} passed` : undefined,
        ok: backtest ? backtest.ok : true,
      });
    } else {
      this.radio('graph_failed', {
        description: 'graph executor',
        detail: `failed nodes: ${failedNodeIds(graph).join(', ') || 'none'}`,
        ok: false,
      });
    }

    return {
      graph,
      converged,
      failedNodeIds: failedNodeIds(graph),
      counts: countByStatus(graph) as unknown as Record<string, number>,
      ...(backtest ? { backtest } : {}),
    };
  }

  /** Run one node: dispatch to the merge handler for `merge` nodes, else a tentacle. */
  private async runNode(node: TaskNode, graph: TaskGraph): Promise<TentacleResult> {
    this.radio('node_start', { description: node.label, agent: node.kind });

    if (node.kind === 'merge') {
      return this.runMergeNode(node, graph);
    }

    const usesWorktree = node.kind === 'general' || node.kind === 'fix';
    const res = await this.runTentacleFn({
      deps: this.deps,
      args: {
        description: node.label,
        prompt: node.prompt,
        scope: node.scope,
        acceptance: node.acceptance,
      },
      agent: node.kind === 'fix' ? 'general' : node.kind,
      thoroughness: 'medium',
      parentCwd: this.parentCwd,
      sessionId: this.sessionId,
      // Defer merge for writers so the executor controls merge ordering
      // (Correction 4); explore/verify never create a worktree.
      deferMerge: usesWorktree,
    });

    if (res.ok && usesWorktree) {
      this.nodeRunState.set(node.id, { worktreeHandle: res.worktreeHandle });
    }
    return res;
  }

  /**
   * Sequentially merge every dep node's deferred worktree (in dep order) into
   * parent HEAD. Deps without a recorded worktree handle (worktree isolation
   * disabled, or a read-only node) are a no-op. On conflict the branch is
   * kept and the conflict is surfaced in the merge node's error — remaining
   * deps still attempt to merge (independent branches shouldn't be blocked
   * by one conflict).
   */
  private async runMergeNode(node: TaskNode, graph: TaskGraph): Promise<TentacleResult> {
    const conflicts: string[] = [];
    const merged: string[] = [];

    for (const depId of node.deps) {
      const state = this.nodeRunState.get(depId);
      const handle = state?.worktreeHandle;
      if (!handle) continue; // nothing to merge for this dep

      let result: WorktreeMergeResult;
      try {
        result = await this.mergeFn(handle, {
          message: `kraken: merge ${graph.nodes.get(depId)?.label ?? depId}`.slice(0, 200),
        });
      } catch (err) {
        result = {
          ok: false,
          merged: false,
          committed: false,
          conflict: true,
          message: `merge threw: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      if (!result.ok) {
        conflicts.push(`${depId}: ${result.message}`);
      } else {
        merged.push(depId);
      }
    }

    if (conflicts.length > 0) {
      return {
        ok: false,
        agent: 'general',
        error: `merge: ${conflicts.length} conflict(s) — ${conflicts.join('; ')}`,
      };
    }

    return {
      ok: true,
      agent: 'general',
      thoroughness: 'medium',
      model: 'n/a',
      result: merged.length > 0 ? `merged: ${merged.join(', ')}` : 'nothing to merge',
      footer: '',
      worktreePath: null,
      worktreeHandle: null,
    };
  }

  /** Apply a tentacle result to its node: success, retry, fix-spawn, or terminal failure. */
  private applyResult(graph: TaskGraph, node: TaskNode, res: TentacleResult): void {
    if (res.ok) {
      node.status = 'done';
      node.result = res.result;
      this.radio('node_end', { description: node.label, agent: node.kind, ok: true });
      return;
    }

    node.error = res.error;

    if (node.retryCount < node.maxRetries) {
      node.retryCount += 1;
      node.status = 'pending';
      this.radio('node_retry', {
        description: node.label,
        agent: node.kind,
        detail: `retry ${node.retryCount}/${node.maxRetries}: ${res.error}`,
        ok: false,
      });
      return;
    }

    if (this.fixBudgetRemaining > 0 && node.kind !== 'fix') {
      this.fixBudgetRemaining -= 1;
      this.fixCounter += 1;
      const fixNode = this.spawnFixNode(graph, node);
      this.radio('node_fix', {
        description: fixNode.label,
        agent: fixNode.kind,
        detail: `spawned to address failure of "${node.label}": ${res.error}`,
        ok: false,
      });
      node.status = 'error';
      return;
    }

    // Retries and fix budget exhausted (or this was itself a fix node):
    // terminal failure. Independent branches keep running; dependents are
    // cascade-skipped by the scheduling loop.
    node.status = 'error';
    this.radio('node_end', {
      description: node.label,
      agent: node.kind,
      detail: res.error,
      ok: false,
    });
  }

  /**
   * Create a `fix` node that attempts to redo the failed node's work, wired
   * so downstream dependents of the failed node also wait on the fix.
   */
  private spawnFixNode(graph: TaskGraph, failed: TaskNode): TaskNode {
    const fixId = `fix-${failed.id}-${this.fixCounter}`;
    const fixNode: TaskNode = {
      id: fixId,
      kind: 'fix',
      label: `fix: ${failed.label}`,
      prompt:
        `The previous attempt at this task failed and must be redone/repaired.\n\n` +
        `## Original task\n${failed.prompt}\n\n` +
        `## Failure\n${failed.error ?? 'unknown error'}`,
      scope: failed.scope,
      acceptance: failed.acceptance,
      deps: [...failed.deps],
      status: 'pending',
      retryCount: 0,
      maxRetries: 0,
      // no further retries — one fix attempt per failed node in v1
    };
    graph.nodes.set(fixId, fixNode);

    // Downstream dependents wait on the fix attempt INSTEAD of the failed
    // node (not in addition to it) — the failed node never becomes `done`,
    // so leaving it in `deps` would strand dependents forever.
    for (const other of graph.nodes.values()) {
      if (other.id === fixId) continue;
      if (other.deps.includes(failed.id)) {
        other.deps = other.deps.map((d) => (d === failed.id ? fixId : d));
      }
    }

    return fixNode;
  }

  /**
   * Mark every `pending` node whose deps include a terminally-failed or
   * skipped node as `skipped`, transitively, so the graph can settle.
   * Returns true if any node was newly skipped.
   */
  private skipBlockedNodes(graph: TaskGraph): boolean {
    let changed = false;
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const node of graph.nodes.values()) {
        if (node.status !== 'pending') continue;
        const blocked = node.deps.some((d) => {
          const dep = graph.nodes.get(d);
          return dep?.status === 'error' || dep?.status === 'skipped';
        });
        if (blocked) {
          node.status = 'skipped';
          changed = true;
          progressed = true;
        }
      }
    }
    return changed;
  }

  private radio(
    kind: 'node_start' | 'node_end' | 'node_retry' | 'node_fix' | 'graph_converged' | 'graph_failed',
    fields: { description: string; agent?: string; detail?: string; ok?: boolean },
  ): void {
    appendKrakenRadio(this.parentCwd, this.sessionId, {
      kind,
      agent: fields.agent ?? 'graph',
      description: fields.description,
      ...(fields.detail !== undefined ? { detail: fields.detail } : {}),
      ...(fields.ok !== undefined ? { ok: fields.ok } : {}),
    });
  }
}
