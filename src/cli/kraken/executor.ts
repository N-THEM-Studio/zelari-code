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
 * Also drives the F5 observability surface: the graph-level live tracker
 * in `./graphStatus.js` (start/update/end around the scheduling loop, for
 * the StatusBar "graph x/y · n↑" chip) alongside the `graph_*`/`node_*`
 * radio events emitted throughout.
 *
 * Explicitly NOT this module's job (deferred to F6):
 *   - planning a graph from a prompt — that's `./planner.js` (F4); the
 *     executor only executes the graph it's given;
 *   - wiring into any slash command, headless flag, or `useChatTurn`.
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
  type TaskAgentKind,
} from './tentacle.js';
import {
  mergeKrakenWorktree,
  type WorktreeHandle,
  type WorktreeMergeResult,
} from '../tools/krakenWorktree.js';
import { appendKrakenRadio } from '../tools/krakenRadio.js';
import { runBacktest, type BacktestResult } from '../workspace/worldModel.js';
import {
  startKrakenGraphLive,
  updateKrakenGraphLive,
  endKrakenGraphLive,
} from './graphStatus.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { saveGraphSnapshot, toGraphSnapshot } from './graphMemory.js';

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

/**
 * Default wall-clock bound per tentacle run (ms). The graph executor calls
 * `runTentacle` directly, bypassing the `task` tool's own `timeoutMs: 300_000`
 * enforcement (that only applies when a parent AgentHarness invokes `task`
 * as a tool-call) — so without an executor-level bound, one stuck sub-agent
 * (a hung bash command, a stalled fetch) hangs `execute()` forever, which
 * hangs the whole headless process (main.ts only calls `process.exit()`
 * after `runHeadless()`'s promise resolves), which leaves the Desktop app's
 * "running" state stuck permanently. Matches the task tool's own budget.
 */
export const DEFAULT_NODE_TIMEOUT_MS = 300_000;

/**
 * Writers get a much larger budget than readers. A `general` (or `fix`) node
 * is a bounded but real coding task — scaffolding a project, adding a
 * subsystem across several files — and 5 minutes is simply not enough for
 * one, especially on a slow reasoning model. `explore` and `verify` nodes are
 * read-only and quick, so they keep the tighter bound.
 *
 * Observed failure that prompted the split: a graph whose two largest general
 * nodes ("project scaffold + ocean integration + shared core", "three ship
 * classes + selection screen + sailing controller") both died on
 * `tentacle timed out after 300000ms`, taking their fix nodes and four
 * cascade-skipped dependents with them.
 */
export const DEFAULT_WRITER_NODE_TIMEOUT_MS = 900_000;

/**
 * How long to wait for a cancelled tentacle to actually unwind before
 * declaring it unstoppable. Cancellation lands at the sub-agent's next event
 * boundary, so this only needs to cover one in-flight provider chunk or tool
 * call, not a whole turn.
 */
export const DEFAULT_CANCEL_GRACE_MS = 30_000;

export function resolveCancelGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ZELARI_KRAKEN_CANCEL_GRACE_MS;
  if (raw === undefined || raw === '') return DEFAULT_CANCEL_GRACE_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CANCEL_GRACE_MS;
}

/**
 * Wall-clock bound for one tentacle. `ZELARI_KRAKEN_NODE_TIMEOUT_MS` overrides
 * every kind (single knob, unchanged semantics: `0` disables);
 * `ZELARI_KRAKEN_WRITER_NODE_TIMEOUT_MS` overrides just the writer budget.
 */
export function resolveNodeTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
  agent?: TaskAgentKind,
): number {
  const raw = env.ZELARI_KRAKEN_NODE_TIMEOUT_MS;
  if (raw !== undefined && raw !== '') {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  if (agent === 'general') {
    const rawWriter = env.ZELARI_KRAKEN_WRITER_NODE_TIMEOUT_MS;
    if (rawWriter !== undefined && rawWriter !== '') {
      const n = Number.parseInt(rawWriter, 10);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return DEFAULT_WRITER_NODE_TIMEOUT_MS;
  }
  return DEFAULT_NODE_TIMEOUT_MS;
}

/**
 * F6 kill-switch: the `/kraken graph` slash command and `--kraken-graph`
 * headless flag both check this before planning/executing anything. On by
 * default, like every other Kraken env toggle (only the literal '0' turns
 * it off — see ZELARI_SCHEMA_LOOP / ZELARI_MEMORY / ZELARI_BROWSER).
 */
export function isKrakenGraphEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ZELARI_KRAKEN_GRAPH !== '0';
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
  /** Original goal text, recorded in the cross-run graph snapshot. */
  goal?: string;
  maxParallel?: number;
  fixBudget?: number;
  /**
   * Wall-clock bound per tentacle run (ms), applied to every node kind. 0
   * disables. Omit to resolve per kind via `resolveNodeTimeoutMs` (writers get
   * a larger budget than readers).
   */
  nodeTimeoutMs?: number;
  /**
   * How long to wait for a cancelled tentacle to unwind before treating it as
   * unstoppable (and therefore un-retryable). Default: resolveCancelGraceMs().
   */
  cancelGraceMs?: number;
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
  private readonly goal: string | undefined;
  private readonly maxParallel: number;
  /** Explicit all-kinds override; when undefined the budget is per-kind. */
  private readonly nodeTimeoutMs: number | undefined;
  private readonly cancelGraceMs: number | undefined;
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
    this.goal = opts.goal;
    this.maxParallel = opts.maxParallel ?? resolveMaxParallel();
    this.nodeTimeoutMs = opts.nodeTimeoutMs;
    this.cancelGraceMs = opts.cancelGraceMs;
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

    startKrakenGraphLive(graph);

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
      updateKrakenGraphLive(graph);
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
    endKrakenGraphLive(graph, converged);

    // Cross-run memory: let the next planning pass see where this one stopped
    // instead of replanning the whole goal blind.
    await saveGraphSnapshot(
      this.parentCwd,
      toGraphSnapshot(graph, { goal: this.goal ?? graph.id, converged }),
    );

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
    const agent: TaskAgentKind = node.kind === 'fix' ? 'general' : node.kind;
    const controller = new AbortController();
    const res = await this.withNodeTimeout(
      this.runTentacleFn({
        deps: this.deps,
        args: {
          description: node.label,
          prompt: node.prompt,
          scope: node.scope,
          acceptance: node.acceptance,
        },
        agent,
        thoroughness: 'medium',
        parentCwd: this.parentCwd,
        sessionId: this.sessionId,
        // Defer merge for writers so the executor controls merge ordering
        // (Correction 4); explore/verify never create a worktree.
        deferMerge: usesWorktree,
        graphId: graph.id,
        nodeId: node.id,
        signal: controller.signal,
      }),
      agent,
      controller,
    );

    if (res.ok && usesWorktree) {
      this.nodeRunState.set(node.id, { worktreeHandle: res.worktreeHandle });
    }
    return res;
  }

  /**
   * Bound a tentacle run to its wall-clock budget (explicit `nodeTimeoutMs`
   * option, else per-kind — writers get more than readers). On timeout the
   * run is CANCELLED via its AbortSignal, then given `cancelGraceMs` to
   * unwind. Cancellation lands at the sub-agent's next event boundary (an
   * async generator only observes `.return()` when it next yields), so a run
   * blocked on a slow provider call can outlive the grace period — that case
   * resolves with `cancelled: false` and `applyResult` refuses to re-spawn
   * the node, since a tentacle that may still be writing must not be joined
   * by a second one on the same scope.
   *
   * Either way `execute()` always settles, so the caller's process can exit
   * instead of hanging forever on one stuck node.
   */
  private async withNodeTimeout(
    promise: Promise<TentacleResult>,
    agent: TaskAgentKind,
    controller?: AbortController,
  ): Promise<TentacleResult> {
    const ms = this.nodeTimeoutMs ?? resolveNodeTimeoutMs(process.env, agent);
    if (ms <= 0) return promise;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const TIMED_OUT = Symbol('timeout');
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), ms);
    });

    const raced = await Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (raced !== TIMED_OUT) return raced;

    // Budget blown. Tell the tentacle to stop, then give it a bounded grace
    // period to actually unwind — a run that has already been told to stop is
    // safe to re-run, one that is still going is not (two agents writing the
    // same scope is exactly the corruption this guards against).
    controller?.abort();
    const graceMs = this.cancelGraceMs ?? resolveCancelGraceMs();
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<typeof TIMED_OUT>((resolve) => {
      graceTimer = setTimeout(() => resolve(TIMED_OUT), graceMs);
    });
    const settled = await Promise.race([promise, grace]).finally(() => {
      if (graceTimer) clearTimeout(graceTimer);
    });

    if (settled !== TIMED_OUT) {
      // The run is over, so the scope is free and a retry/fix would be safe.
      // If it actually SUCCEEDED — finishing in the window between the
      // deadline and the abort landing — keep that result rather than
      // discarding completed (and already written) work over a few ms.
      if (settled.ok) return settled;
      return { ...settled, cancelled: true };
    }
    // Did not stop in time. Report it as uncancelled so `applyResult` refuses
    // to re-spawn this node — better one failed node than two concurrent
    // writers on one directory.
    return {
      ok: false,
      agent,
      error:
        `tentacle timed out after ${ms}ms and did not stop within ${graceMs}ms of being cancelled; ` +
        `not retrying to avoid two tentacles writing the same scope`,
      cancelled: false,
    };
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

    // A run we could not confirm has stopped may still be writing this node's
    // scope. Re-spawning would put two tentacles in the same directory — the
    // failure mode that produced duplicate parallel implementations of the
    // same modules. Fail terminally instead; dependents cascade-skip.
    if (res.cancelled === false) {
      node.status = 'error';
      this.radio('node_end', {
        description: node.label,
        agent: node.kind,
        detail: res.error,
        ok: false,
      });
      return;
    }

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
