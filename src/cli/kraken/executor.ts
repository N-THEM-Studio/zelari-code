/**
 * KrakenGraphExecutor — F3: drives a TaskGraph to convergence.
 *
 * Consumes the pure primitives from `@zelari/core` (getReadyNodes,
 * selectParallelWave, isSettled/isConverged) and the F2 tentacle runner
 * (`runTentacle`) to execute a validated `TaskGraph`:
 *   - repeatedly forms a parallel-safe "wave" of ready nodes (bounded by
 *     ZELARI_KRAKEN_MAX_PARALLEL) and runs it concurrently;
 *   - hands each node the conclusions of its completed dependencies
 *     (`buildUpstreamContext`), so a dep edge carries information and not just
 *     ordering;
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
  type TaskNodeKind,
  getReadyNodes,
  isSettled,
  isConverged,
  failedNodeIds,
  countByStatus,
  canRunParallel,
  parseVerifyVerdict,
  type UnresolvedFinding,
} from '@zelari/core';
import {
  runTentacle,
  TASK_TOOL_TIMEOUT_MS,
  type RunTentacleOptions,
  type TentacleResult,
  type TaskToolDeps,
  type TaskAgentKind,
  type TaskThoroughness,
} from './tentacle.js';
import {
  mergeKrakenWorktree,
  type WorktreeHandle,
  type WorktreeMergeResult,
} from '../tools/krakenWorktree.js';
import { appendKrakenRadio } from '../tools/krakenRadio.js';
import { runTransactional } from './transactional.js';
import { runBacktest, type BacktestResult } from '../workspace/worldModel.js';
import {
  startKrakenGraphLive,
  updateKrakenGraphLive,
  endKrakenGraphLive,
} from './graphStatus.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { saveGraphSnapshot, toGraphSnapshot } from './graphMemory.js';
import { WorkbenchWriter, type WorkbenchNode } from './workbench.js';
import { arbitrateAdmission, caseInsensitiveFs, hasWriteOverlap } from './fileOwnership.js';
import {
  isWorktreeCapableKind,
  resolveWorktreeMode,
  worktreeSchedulingDecision,
} from './worktreeScheduling.js';
import {
  semanticConflictDecision,
  type SemanticConflictCtx,
} from './semanticOwnership.js';
import { isAstSupported, parseFileSymbolsDiag } from '../ast/engine.js';
// t29 (§15–16): fail-open reputation recording + routing source refresh.
import { calculateCost } from '../modelPricing.js';
import {
  aggregate,
  REPUTATION_MIN_SAMPLE,
  reputationRecordFromNodeRun,
  type ReputationRecord,
} from './modelReputation.js';
// t30 (§17): spawn-ROI gate — deterministic score, threshold parsing and the
// duplication-risk heuristic; the veto itself lives in this class (fail-open).
import {
  computeSpawnScore,
  duplicationRiskFor,
  parseRoiThreshold,
  shouldSpawn,
  type SpawnRoiInput,
  type SpawnRoiTaskKind,
  type SpawnScoreResult,
} from './spawnRoi.js';
import {
  appendRecord,
  DEFAULT_MAX_RECORDS,
  loadRecords,
  pruneStore,
  resolveReputationStorePath,
} from './reputationStore.js';
import { setReputationSource } from './verifierRouting.js';

/**
 * P2.B default symbol extractor behind semantic ownership arbitration: the
 * real AST outline via ast/engine. Lazy (the TS compiler API loads inside
 * `parseFileSymbolsDiag` on first use) and fail-closed — an unsupported file
 * or any parse failure is null, which the decision reports as a conflict so
 * the pair defers to the sequential path instead of trusting a claim it
 * could not verify.
 */
async function defaultSymbolExtractor(file: string): Promise<readonly string[] | null> {
  if (!isAstSupported(file)) return null;
  const r = await parseFileSymbolsDiag(file);
  return r.status === 'ok' ? r.symbols.map((s) => s.name) : null;
}

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

/**
 * Transactional writer execution (P2.D), default OFF: a rollback discards
 * partial work the existing fix/rework flow might have reused, and the
 * whole-tree restore can revert a concurrent in-place sibling's writes.
 * Opt in per run (`transactional: true`) or via env.
 */
export const DEFAULT_TRANSACTIONAL = false;

/** `ZELARI_KRAKEN_TRANSACTIONAL === '1'` turns transactional writers on. */
export function resolveTransactional(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ZELARI_KRAKEN_TRANSACTIONAL === '1';
}

/**
 * How many `fix` nodes this run may spawn.
 *
 * A flat budget of 3 is a graph-size-blind number: on a 20-node graph it is
 * spent on the first three failures and every later failure goes terminal,
 * cascade-skipping its dependents — the larger the graph, the less repair it
 * gets, which is backwards. Scale with the node count, keeping 3 as the floor
 * for small graphs. An explicit env value still wins outright.
 */
export function resolveFixBudget(
  env: NodeJS.ProcessEnv = process.env,
  nodeCount = 0,
): number {
  const raw = env.ZELARI_KRAKEN_FIX_BUDGET;
  if (raw === undefined || raw === '') {
    return Math.max(DEFAULT_FIX_BUDGET, Math.ceil(nodeCount / 2));
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0
    ? n
    : Math.max(DEFAULT_FIX_BUDGET, Math.ceil(nodeCount / 2));
}

/**
 * Default rework rounds per writer when its `verify` returns FAIL.
 *
 * One. A rework round is a full re-run of a writer plus a fresh verification,
 * so the cost is roughly a doubling of that branch; and the second opinion of
 * a model that just judged its own sibling's work has sharply diminishing
 * value. Raise it deliberately (and with a wall-clock budget set) rather than
 * by default.
 */
export const DEFAULT_MAX_REVIEW_ROUNDS = 1;

export function resolveMaxReviewRounds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ZELARI_KRAKEN_MAX_REVIEW_ROUNDS;
  if (raw === undefined || raw === '') return DEFAULT_MAX_REVIEW_ROUNDS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_REVIEW_ROUNDS;
}

/**
 * Wall-clock bound on the WHOLE graph run (ms); 0 (the default) disables it.
 *
 * Per-node timeouts bound each tentacle but say nothing about the total: a
 * wide graph, plus retries, plus fix nodes, plus rework rounds, can run far
 * longer than any single node's budget without anything noticing. On expiry
 * the run takes the ordinary cancellation path, so it still settles and still
 * prints its digest.
 */
export const DEFAULT_GRAPH_TIMEOUT_MS = 0;

export function resolveGraphTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ZELARI_KRAKEN_GRAPH_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_GRAPH_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_GRAPH_TIMEOUT_MS;
}

/**
 * Default wall-clock bound per tentacle run (ms). The graph executor calls
 * `runTentacle` directly, bypassing the `task` tool wrapper — so without an
 * executor-level bound, one stuck sub-agent hangs `execute()` forever, which
 * hangs the whole headless process (main.ts only calls `process.exit()`
 * after `runHeadless()`'s promise resolves), which leaves the Desktop app's
 * "running" state stuck permanently. Explore/verify keep this tighter budget;
 * writers use DEFAULT_WRITER_NODE_TIMEOUT_MS (same as TASK_TOOL_TIMEOUT_MS).
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
 * cascade-skipped dependents with them. The `task` tool wrapper used to
 * enforce the same 5-minute cap, so a parent-spawned general tentacle could
 * time out while still writing — keep this identical to TASK_TOOL_TIMEOUT_MS.
 */
export const DEFAULT_WRITER_NODE_TIMEOUT_MS = TASK_TOOL_TIMEOUT_MS;

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

/**
 * Per-dependency cap on injected upstream text. Mirrors `MAX_PRIOR_CHARS` in
 * the council path (`packages/core/src/agents/councilApi.ts`), for the same
 * reason: one verbose tentacle must not be able to saturate every downstream
 * one.
 */
export const MAX_UPSTREAM_CHARS_PER_DEP = 2800;

/** Total cap across all deps, so a wide fan-in cannot saturate a sub-agent. */
export const MAX_UPSTREAM_CHARS_TOTAL = 8000;

/**
 * Render the conclusions of a node's already-completed dependencies as a
 * prompt section for the sub-agent about to run.
 *
 * Without this the dependency edges were pure ordering constraints: a tentacle
 * received only the prompt the PLANNER wrote before anything had executed, so
 * an `explore` node's findings were computed, stored on the node, and then
 * thrown away — the `general` nodes it "fed" started from zero and re-derived
 * the same context (or guessed). The auto-injected `verify` node was worse
 * still: it knew only the label of the work it was supposed to check.
 *
 * Direct dependencies only, deliberately — the transitive closure of a wide
 * DAG would blow the sub-agent's context, and each hop's own conclusion is
 * expected to carry forward what mattered.
 */
export function buildUpstreamContext(graph: TaskGraph, node: TaskNode): string {
  const parts: string[] = [];
  const omitted: string[] = [];
  let budget = MAX_UPSTREAM_CHARS_TOTAL;

  for (const depId of node.deps) {
    const dep = graph.nodes.get(depId);
    if (!dep || dep.status !== 'done') continue;
    const raw = (dep.result ?? '').trim();
    if (!raw) continue;

    const cap = Math.min(MAX_UPSTREAM_CHARS_PER_DEP, budget);
    if (cap <= 0) {
      omitted.push(dep.label);
      continue;
    }
    const body =
      raw.length > cap
        ? `${raw.slice(0, cap)}\n… [truncated ${raw.length}→${cap} chars]`
        : raw;
    budget -= Math.min(raw.length, cap);

    const scope =
      dep.scope && dep.scope.length > 0 ? `, scope: ${dep.scope.join(', ')}` : '';
    parts.push(`### ${dep.label} (${dep.kind}${scope})\n${body}`);
  }

  if (parts.length === 0) return '';

  const lines = [
    '',
    '## Context from completed upstream tasks',
    'Results reported by the tasks this one depends on. Treat them as ' +
      'hypotheses — prefer the actual files on disk where they conflict.',
    '',
    ...parts,
  ];
  if (omitted.length > 0) {
    lines.push('', `(omitted for context budget: ${omitted.join(', ')})`);
  }
  return lines.join('\n');
}

/**
 * Tool budget per node kind. Writers do real, multi-file work and were being
 * run at the same `medium` budget as a read-only lookup; readers stay tight
 * because a wide budget just invites them to dump the repository.
 */
export function thoroughnessForKind(kind: TaskNodeKind): TaskThoroughness {
  return kind === 'general' || kind === 'fix' ? 'deep' : 'medium';
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
  /** Fix-node budget for the whole run. Omit to scale with the graph size. */
  fixBudget?: number;
  /** Rework rounds allowed per writer whose verify returns FAIL. Default 1. */
  maxReviewRounds?: number;
  /**
   * Wall-clock bound on the whole run (ms), 0 to disable. Omit to resolve from
   * ZELARI_KRAKEN_GRAPH_TIMEOUT_MS. On expiry the run is cancelled through the
   * same path as `signal`, so it still settles and still returns a summary.
   */
  graphTimeoutMs?: number;
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
  /**
   * P2.D: run `general` (writer) tentacles transactionally — checkpoint the
   * parent working tree before the run, roll it back if the node fails, keep
   * the checkpoint as a recovery point on success. Explore/verify/merge and
   * rework paths are never wrapped. Default: resolveTransactional() (env
   * ZELARI_KRAKEN_TRANSACTIONAL === '1'; off by default).
   */
  transactional?: boolean;
  /**
   * Fold character case when comparing write scopes during ownership
   * arbitration (P2.A). win32/darwin filesystems are case-insensitive, so
   * `SRC/**` and `src/**` there are the same tree; default follows
   * `process.platform` like sandboxPath.
   */
  ownershipCaseFolding?: boolean;
  /**
   * P2.B: symbol-name extractor backing semantic ownership arbitration. Only
   * invoked when BOTH deferred/racing writers declare `ownedSymbols` and the
   * contested file is AST-supported. Defaults to the real ast/engine outline
   * (fail-closed: parse failure ⇒ defer); tests inject stubs. Returning null
   * or throwing never widens parallelism — the pair stays deferred.
   */
  symbolExtractor?: (file: string) => Promise<readonly string[] | null>;
  /**
   * P2.F: reputation records backing the spawn-ROI gate. Omit to load the
   * repo's t29 store once per run (a missing/corrupt store behaves as "no
   * history" ⇒ default score); tests inject fixtures.
   */
  reputationRecords?: readonly ReputationRecord[];
  /**
   * P2.F: pure score seam for the ROI gate (default {@link computeSpawnScore}).
   * Tests inject a throwing stub to prove the gate's fail-open contract.
   */
  roiScoreFn?: (input: SpawnRoiInput) => SpawnScoreResult;
  /**
   * Cancels the whole graph run. Aborting stops admitting new nodes and
   * cancels every in-flight tentacle; the run then settles normally (nodes
   * still running end as errors, nodes never started end as `skipped`) so the
   * caller always gets a summary and the process can exit. Without this a
   * graph could only be stopped by killing the process, which left worktrees
   * and half-written files behind.
   */
  signal?: AbortSignal;
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
  /** Wall-clock time each node's run took, by node id. */
  durationsMs: Record<string, number>;
  /** True when the run stopped because its `signal` aborted. */
  cancelled: boolean;
  /**
   * Verify verdicts the run could not resolve: either the rework budget ran
   * out with the verify still failing, or the verify never emitted a parseable
   * verdict. The graph still converges (the work exists and is merged) — but
   * "converged" would otherwise be indistinguishable from "converged clean",
   * and the next run would treat the node as finished business.
   */
  unresolvedFindings: UnresolvedFinding[];
}

/** One node's outcome, tracked internally for merge/fix bookkeeping. */
interface NodeRunState {
  worktreeHandle: WorktreeHandle | null;
}

/** A finished in-flight node, identified so the scheduler knows what settled. */
interface SettledNode {
  id: string;
  res: TentacleResult;
}

/** First non-empty line of a block of text, capped — for one-line markers. */
function firstLine(text: string, maxChars = 160): string {
  const line = text.trim().split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
  return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line;
}

/** The tentacle kind a node runs as (`fix`/`merge` are driven as `general`). */
function agentForNode(node: TaskNode): TaskAgentKind {
  return node.kind === 'explore' || node.kind === 'verify' ? node.kind : 'general';
}

/** P2.F: fold a graph node kind onto the ROI task-kind taxonomy. */
function roiTaskKindOf(kind: string): SpawnRoiTaskKind {
  if (kind === 'explore') return 'explore';
  if (kind === 'verify') return 'verify';
  if (kind === 'spec' || kind === 'conformance') return 'review';
  return 'implement'; // general/fix/merge and unknown kinds all mutate the tree
}

export class KrakenGraphExecutor {
  private readonly deps: TaskToolDeps;
  private readonly parentCwd: string;
  private readonly sessionId: string;
  private readonly goal: string | undefined;
  private readonly maxParallel: number;
  /** Fold case in ownership scope comparisons (win32/darwin FSes). */
  private readonly ownershipCaseFolding: boolean;
  /** P2.B: symbol extractor for semantic ownership (default: ast/engine). */
  private readonly symbolExtractor: (file: string) => Promise<readonly string[] | null>;
  /** Explicit all-kinds override; when undefined the budget is per-kind. */
  private readonly nodeTimeoutMs: number | undefined;
  private readonly cancelGraceMs: number | undefined;
  /** Explicit override; when undefined the budget scales with the graph size. */
  private readonly fixBudgetOption: number | undefined;
  private fixBudgetRemaining: number;
  private readonly maxReviewRounds: number;
  private readonly graphTimeoutMs: number;
  private readonly worldModelGateOverride: boolean | undefined;
  /** P2.D: wrap general (writer) tentacles in checkpoint→run→rollback. */
  private readonly transactional: boolean;
  private readonly runTentacleFn: (opts: RunTentacleOptions) => Promise<TentacleResult>;
  private readonly mergeFn: (
    handle: WorktreeHandle,
    opts?: { message?: string; cleanup?: boolean },
  ) => Promise<WorktreeMergeResult>;
  private readonly backtestFn: (cwd: string) => Promise<BacktestResult>;
  /** P2.F: pure score seam for the ROI gate (default: computeSpawnScore). */
  private readonly roiScoreFn: (input: SpawnRoiInput) => SpawnScoreResult;
  /** P2.F: ROI reputation source; null until resolved once per run. */
  private roiReputation: readonly ReputationRecord[] | null;

  /** Live workbench writer for this run (created once the graph starts). */
  private wb: WorkbenchWriter | null = null;

  private readonly nodeRunState = new Map<string, NodeRunState>();
  /** Graph node id → durable cognitive-memory id produced by its tentacle. */
  private readonly memoryIds = new Map<string, string>();
  /** fix node id → id of the failed node it was spawned to repair. */
  private readonly repairs = new Map<string, string>();
  /**
   * rework node id → id of the writer whose work it is redoing. A rework is a
   * `fix` node, but unlike a repair it must NOT create a worktree of its own:
   * it edits the writer's existing one (see {@link spawnReworkPair}).
   */
  private readonly reworks = new Map<string, string>();
  /** lineage root writer id → rework rounds already spent on that lineage. */
  private readonly reviewRounds = new Map<string, number>();
  /**
   * rework node id → the ORIGINAL writer its lineage started from.
   *
   * The budget has to be per lineage, not per node: a rework is itself a
   * writer, so counting rounds against the node being reworked reset the
   * counter every round and the graph chained rework → verify → rework
   * forever, terminating only on the scheduler's iteration cap.
   */
  private readonly reviewLineage = new Map<string, string>();
  /** Verify verdicts left unresolved when the run ends. */
  private readonly unresolved: UnresolvedFinding[] = [];
  /** Live cancellation handles for the tentacles currently running. */
  private readonly nodeControllers = new Map<string, AbortController>();
  /** Wall-clock duration of each node's last run, by node id. */
  private readonly durationsMs = new Map<string, number>();
  private readonly signal: AbortSignal | undefined;
  /** Set once the run has been cancelled: stops admission, retries and fixes. */
  private aborted = false;
  private fixCounter = 0;

  constructor(opts: KrakenGraphExecutorOptions) {
    this.deps = opts.taskToolDeps;
    this.parentCwd = opts.parentCwd;
    this.sessionId = opts.sessionId;
    this.goal = opts.goal;
    this.maxParallel = opts.maxParallel ?? resolveMaxParallel();
    this.ownershipCaseFolding =
      opts.ownershipCaseFolding ?? caseInsensitiveFs(process.platform);
    this.symbolExtractor = opts.symbolExtractor ?? defaultSymbolExtractor;
    this.nodeTimeoutMs = opts.nodeTimeoutMs;
    this.cancelGraceMs = opts.cancelGraceMs;
    this.fixBudgetOption = opts.fixBudget;
    // Provisional: `execute()` re-resolves it once the graph size is known.
    this.fixBudgetRemaining = opts.fixBudget ?? resolveFixBudget();
    this.maxReviewRounds = opts.maxReviewRounds ?? resolveMaxReviewRounds();
    this.graphTimeoutMs = opts.graphTimeoutMs ?? resolveGraphTimeoutMs();
    this.worldModelGateOverride = opts.worldModelGate;
    this.transactional = opts.transactional ?? resolveTransactional();
    this.signal = opts.signal;
    this.runTentacleFn = opts.runTentacleFn ?? runTentacle;
    this.mergeFn = opts.mergeFn ?? mergeKrakenWorktree;
    this.backtestFn = opts.backtestFn ?? runBacktest;
    this.roiScoreFn = opts.roiScoreFn ?? computeSpawnScore;
    this.roiReputation = opts.reputationRecords ?? null;
  }

  /** Map a graph node onto the workbench's node shape. */
  private toWorkbenchNode(n: TaskNode): WorkbenchNode {
    return {
      id: n.id,
      kind: n.kind,
      label: n.label,
      status: n.status,
      ...(n.scope && n.scope.length > 0 ? { scope: n.scope } : {}),
      ...(n.deps.length > 0 ? { deps: n.deps } : {}),
    };
  }

  /**
   * Create (once) and seed the live workbench writer for this graph. This is
   * what makes the `.zelari/radio/workbench-<graphId>.md` file exist at all —
   * the desktop graph/tail tabs read that file, and before this wiring
   * nothing in the production flow ever constructed the writer, so the tabs
   * stayed empty no matter how much the graph ran.
   */
  private initWorkbench(graph: TaskGraph): void {
    if (this.wb) return;
    this.wb = new WorkbenchWriter({
      cwd: this.parentCwd,
      graphId: graph.id,
      goal: this.goal ?? graph.id,
    });
    this.wb.setNodes([...graph.nodes.values()].map((n) => this.toWorkbenchNode(n)));
    this.wb.logEvent(`graph_start ${graph.id} (${graph.nodes.size} nodes)`);
  }

  /** Mark every skipped node in the workbench. Cheap and idempotent enough
   *  to call after each cascade-skip pass. */
  private syncWorkbenchSkipped(graph: TaskGraph): void {
    for (const n of graph.nodes.values()) {
      if (n.status === 'skipped') this.wb?.markEnd(n.id, { status: 'skipped' });
    }
  }

  private isReviewerKind(kind: TaskNodeKind): boolean {
    return kind === 'verify' || kind === 'spec' || kind === 'conformance';
  }

  /** Execute the graph in place (mutates node statuses) until it settles. */
  async execute(graph: TaskGraph): Promise<KrakenExecutionSummary> {
    // t29: refresh the reputation source (fail-open, fire-and-forget) so
    // verifier routing consulted later in this process sees real history.
    void this.refreshReputationSource();
    // Now that the graph is known, size the repair budget to it (unless the
    // caller pinned one). Done here rather than in the constructor because the
    // node count is the whole input to the decision.
    if (this.fixBudgetOption === undefined) {
      this.fixBudgetRemaining = resolveFixBudget(process.env, graph.nodes.size);
    }

    // Cancel eagerly rather than at the next loop turn: without a listener the
    // scheduler would sit in `Promise.race` until some node finished on its
    // own, which for a stuck writer is the whole point of cancelling.
    const onAbort = (): void => this.cancelRun();
    if (this.signal) {
      if (this.signal.aborted) this.aborted = true;
      else this.signal.addEventListener('abort', onAbort, { once: true });
    }

    // Whole-run wall-clock bound. Reuses the cancellation path rather than
    // inventing a second way to stop, so the run still settles and still
    // reports.
    let graphTimer: ReturnType<typeof setTimeout> | undefined;
    if (this.graphTimeoutMs > 0) {
      graphTimer = setTimeout(() => {
        this.radio('graph_failed', {
          description: 'graph executor',
          detail: `graph exceeded its ${this.graphTimeoutMs}ms wall-clock budget — cancelling`,
          ok: false,
        });
        this.cancelRun();
      }, this.graphTimeoutMs);
      // Do not hold the process open just to fire a cancellation.
      graphTimer.unref?.();
    }

    try {
      return await this.schedule(graph);
    } finally {
      if (graphTimer) clearTimeout(graphTimer);
      this.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** The scheduling loop proper. See {@link execute} for the cancellation wrapper. */
  private async schedule(graph: TaskGraph): Promise<KrakenExecutionSummary> {
    // Anti-explosion / self-inflicted-hang guard: cap total loop iterations
    // at a generous multiple of the node count instead of trusting the
    // graph to always shrink monotonically (fix-node spawns grow it).
    const maxIterations = Math.max(64, graph.nodes.size * 8);
    let iterations = 0;

    /** Node id → its running tentacle. One entry per in-flight node. */
    const inFlight = new Map<string, Promise<SettledNode>>();

    startKrakenGraphLive(graph);
    this.initWorkbench(graph);

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
      if (this.aborted && inFlight.size === 0) break;

      // Admit everything that can start alongside what is already running,
      // up to the concurrency cap. A cancelled run admits nothing.
      const admitted = this.aborted ? [] : await this.admit(graph, inFlight);
      if (admitted.length > 0) {
        // Mark and publish the whole admission BEFORE starting any of it: an
        // async function body runs synchronously up to its first await, so
        // starting a tentacle first would let it observe stale counts. (The
        // StatusBar's "n↑" never appeared at all while this was sampled only
        // after the work had already settled.)
        for (const node of admitted) node.status = 'running';
        updateKrakenGraphLive(graph);
        for (const node of admitted) {
          this.wb?.markStart(node.id, {
            kind: node.kind,
            label: node.label,
            ...(node.scope && node.scope.length > 0 ? { scope: node.scope } : {}),
            ...(node.deps.length > 0 ? { deps: node.deps } : {}),
          });
        }
        if (admitted.length > 0) this.wb?.markWave(admitted.map((n) => n.id));
        for (const node of admitted) inFlight.set(node.id, this.runNodeSafely(node, graph));
      }

      if (inFlight.size === 0) {
        // Nothing running and nothing admissible: the remaining pending nodes
        // are permanently blocked by a failed/skipped dependency (or by the
        // run being cancelled). Cascade skip them so the loop can terminate.
        if (this.skipBlockedNodes(graph)) {
          this.syncWorkbenchSkipped(graph);
          continue;
        }
        // Nothing ready, nothing running, nothing to skip — should not
        // happen for a validated DAG, but bail out rather than spin forever.
        break;
      }

      // Settle ONE node at a time. Waiting for a whole wave meant a 15-minute
      // writer held back every explore that became ready a second later, and
      // left the concurrency budget idle for the duration.
      const { id, res } = await Promise.race(inFlight.values());
      inFlight.delete(id);
      const settledNode = graph.nodes.get(id);
      if (settledNode) this.applyResult(graph, settledNode, res);
      updateKrakenGraphLive(graph);
    }

    // The loop can break with work still in flight (iteration cap, or a
    // cancellation whose tentacles have not unwound yet). Let those settle
    // rather than returning a summary while they are still writing, and
    // record what they produced.
    if (inFlight.size > 0) {
      for (const { id, res } of await Promise.all(inFlight.values())) {
        const node = graph.nodes.get(id);
        if (node) this.applyResult(graph, node, res);
      }
      inFlight.clear();
    }

    // A cancelled run leaves nodes that never started: `skipped` says exactly
    // that, and lets the graph settle so a summary can be returned.
    if (this.aborted) {
      for (const n of graph.nodes.values()) {
        if (n.status === 'pending') n.status = 'skipped';
      }
      this.syncWorkbenchSkipped(graph);
    }

    let backtest: BacktestResult | undefined;
    const converged = !this.aborted && isConverged(graph);
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
        detail: this.aborted
          ? 'cancelled by caller'
          : `failed nodes: ${failedNodeIds(graph).join(', ') || 'none'}`,
        ok: false,
      });
    }
    endKrakenGraphLive(graph, converged);

    // Final workbench snapshot: emit the outcome event and force a write so
    // the desktop graph/tail tabs show the settled graph even if the process
    // exits right after (the 500ms debounce alone could drop the last state).
    this.wb?.logEvent(
      converged
        ? 'graph_converged'
        : `graph_failed: ${this.aborted ? 'cancelled' : (failedNodeIds(graph).join(', ') || 'none')}`,
    );
    await this.wb?.flush();
    this.wb?.close();

    // Persist graph semantics only after every tentacle has settled. This is
    // fail-open and never changes convergence: memory records the execution,
    // it does not govern it.
    await this.linkMemoryGraph(graph, converged);

    // Cross-run memory: let the next planning pass see where this one stopped
    // instead of replanning the whole goal blind.
    await saveGraphSnapshot(
      this.parentCwd,
      toGraphSnapshot(graph, {
        goal: this.goal ?? graph.id,
        converged,
        unresolvedFindings: this.unresolved,
      }),
    );

    return {
      graph,
      converged,
      failedNodeIds: failedNodeIds(graph),
      counts: countByStatus(graph) as unknown as Record<string, number>,
      durationsMs: Object.fromEntries(this.durationsMs),
      cancelled: this.aborted,
      unresolvedFindings: [...this.unresolved],
      ...(backtest ? { backtest } : {}),
    };
  }

  /**
   * Stop the run: no further admissions, and every tentacle currently running
   * is told to unwind. Each node's own timeout/grace machinery then resolves
   * it, so `execute()` settles instead of leaving orphans behind.
   */
  private cancelRun(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.radio('graph_failed', {
      description: 'graph executor',
      detail: `cancelling ${this.nodeControllers.size} running tentacle(s)`,
      ok: false,
    });
    for (const controller of this.nodeControllers.values()) controller.abort();
  }

  /**
   * Pick the ready nodes that may start right now: parallel-safe against every
   * node already running AND against each other, within the concurrency cap.
   *
   * Unlike a wave-at-a-time scheduler this is called on every completion, so a
   * node becomes eligible the moment its blocker settles instead of waiting
   * for the slowest member of some earlier batch.
   *
   * The surviving list then goes through file-ownership arbitration (P2.A):
   * a writer whose scope overlaps a writer already admitted this round or
   * already in flight is DEFERRED, never failed — it stays READY and is
   * re-offered on the next completion, so overlapping writers serialize via
   * the ordinary settle-one-at-a-time loop.
   *
   * P2.C exception: with ZELARI_KRAKEN_WORKTREE=auto a deferred writer whose
   * overlap is merely partial (score < 0.75, `classifyOverlap`) is re-admitted
   * immediately under git worktree isolation instead of idling behind its
   * racing writer.
   */
  private async admit(
    graph: TaskGraph,
    inFlight: Map<string, Promise<SettledNode>>,
  ): Promise<TaskNode[]> {
    const capacity = this.maxParallel - inFlight.size;
    if (capacity <= 0) return [];

    const running: TaskNode[] = [];
    for (const id of inFlight.keys()) {
      const n = graph.nodes.get(id);
      if (n) running.push(n);
    }

    const candidates: TaskNode[] = [];
    for (const node of getReadyNodes(graph)) {
      if (candidates.length >= capacity) break;
      const safe =
        running.every((r) => canRunParallel(r, node)) &&
        candidates.every((a) => canRunParallel(a, node));
      if (safe) candidates.push(node);
    }

    // P2.A: two writers with overlapping scopes must never share the tree.
    // Arbitration can only shrink the candidate list, so this is pure
    // defense-in-depth on top of canRunParallel — plus case folding on
    // win32/darwin and a workbench/radio trail for every deferral.
    const { admitted, deferred } = arbitrateAdmission(candidates, running, {
      caseInsensitive: this.ownershipCaseFolding,
    });

    // P2.C: with ZELARI_KRAKEN_WORKTREE=auto, a writer arbitration would defer
    // against another writer can still start NOW when the overlap is merely
    // partial/containment — it runs in its own git worktree and tentacle
    // merges stay sequential (Correction 4), so the race is merge-safe by
    // construction and a cheap merge beats idling. Identical-grain overlap
    // (same scope, wildcard claims folded to a match) still defers: that
    // merge would cost more than the serialization. Any other mode keeps the
    // deferral exactly as P2.A left it.
    const worktreeMode = resolveWorktreeMode(process.env.ZELARI_KRAKEN_WORKTREE);
    const rescued: TaskNode[] = [];
    const held: TaskNode[] = [];
    if (worktreeMode === 'auto' && deferred.length > 0) {
      // The race set to score against: everything in flight PLUS everything
      // admitted this round — those are running the moment admit() returns,
      // and a first-round clash would otherwise never be rescuable (running
      // is still empty then).
      const racing: TaskNode[] = [...running, ...admitted];
      for (const node of deferred) {
        const decision =
          isWorktreeCapableKind(node.kind) &&
          !this.reworks.has(node.id) && // a rework edits an EXISTING worktree
          this.deps.allowWorktree !== false
            ? worktreeSchedulingDecision(node, racing, process.env, {
                caseInsensitive: this.ownershipCaseFolding,
              })
            : undefined;
        if (decision && decision.mode === 'parallel-worktree') {
          rescued.push(node);
          this.radio('node_worktree_scheduled', {
            description: node.label,
            agent: node.kind,
            detail: `worktree-isolated parallel admission: overlap=${decision.overlapScore.toFixed(2)} (${decision.rationaleCode})`,
            ok: true,
            nodeId: node.id,
            overlapScore: decision.overlapScore,
            rationaleCode: decision.rationaleCode,
            ...(decision.bestMatchId !== undefined
              ? { runningNode: decision.bestMatchId }
              : {}),
          });
          this.wb?.logEvent(
            `worktree-scheduled ${node.id} "${node.label}" — overlap ${decision.overlapScore.toFixed(2)} (${decision.rationaleCode}) vs ${decision.bestMatchId ?? 'writer'}; runs isolated, merge stays sequential`,
          );
        } else {
          held.push(node);
        }
      }
    } else {
      held.push(...deferred);
    }

    // P2.B: semantic rescue — a writer the arbitration still holds whose
    // deferral is pure same-file grain can run alongside its racer when BOTH
    // sides declare `ownedSymbols` and every contested pair verifies as
    // symbol-disjoint. One undecided or conflicting pair keeps the t25
    // deferral intact (fail-closed: undeclared claims, malformed specs and
    // AST extraction failures all defer). When worktree scheduling is `auto`
    // and the node is isolatable it reuses the t27 worktree path (same-file
    // different-symbol is still a git merge risk); otherwise it is admitted
    // plainly, with telemetry saying exactly that.
    const semAdmitted: TaskNode[] = [];
    if (held.length > 0) {
      // Everything the node would race: in flight, admitted this round, or
      // already rescued above (worktree-isolated but still concurrent).
      const racing: TaskNode[] = [...running, ...admitted, ...rescued];
      const ctx: SemanticConflictCtx = {
        extractSymbols: this.symbolExtractor,
        astSupported: isAstSupported,
      };
      for (const node of held) {
        const verdict = await this.semanticRescueDecision(node, racing, ctx);
        if (!verdict) continue;
        const isolatable =
          worktreeMode === 'auto' &&
          isWorktreeCapableKind(node.kind) &&
          !this.reworks.has(node.id) && // a rework edits an EXISTING worktree
          this.deps.allowWorktree !== false;
        this.radio('node_semantic_admitted', {
          description: node.label,
          agent: node.kind,
          detail: `semantic admission: disjoint symbol claims on ${verdict.contestedFile} vs ${verdict.racerId} (${verdict.reasonCode}) — ${isolatable ? 'worktree-isolated' : 'plain parallel; same-file merge risk'}`,
          ok: true,
          nodeId: node.id,
          rationaleCode: isolatable ? 'semantic-disjoint-worktree' : 'semantic-disjoint-plain',
          runningNode: verdict.racerId,
          contestedFile: verdict.contestedFile,
          symbolsA: verdict.symbolsA,
          symbolsB: verdict.symbolsB,
        });
        this.wb?.logEvent(
          `semantic-admitted ${node.id} "${node.label}" — disjoint claims on ${verdict.contestedFile} vs ${verdict.racerId} (${verdict.reasonCode}); ${isolatable ? 'runs worktree-isolated' : 'runs plainly alongside'}`,
        );
        if (isolatable) rescued.push(node);
        else {
          semAdmitted.push(node);
          racing.push(node); // later held nodes must be arbitrated against it too
        }
      }
    }
    for (const node of held) {
      if (rescued.includes(node) || semAdmitted.includes(node)) continue;
      const scopes = node.scope && node.scope.length > 0 ? node.scope.join(', ') : '**';
      this.radio('node_deferred', {
        description: node.label,
        agent: node.kind,
        detail: `deferred: write scope (${scopes}) overlaps a running writer — stays READY`,
        ok: true,
      });
      this.wb?.logEvent(
        `deferred ${node.id} "${node.label}" — write scope (${scopes}) overlaps a running writer; stays ready for the next round`,
      );
    }
    // P2.F: spawn-ROI gate — every tentacle spawn must have positive expected
    // value. Runs AFTER ownership arbitration and both rescues, so it can only
    // shrink the final spawn list; a node scoring below the threshold goes
    // back the deferred path (stays READY, re-offered next round — never
    // failed) with a `node_roi_vetoed` radio trail. Fail-open: any error
    // inside the gate spawns the batch (see roiGate).
    return (await this.roiGate([...admitted, ...rescued, ...semAdmitted], running)).spawn;
  }

  /**
   * P2.F: resolve the ROI gate's reputation source once per run — the
   * injected fixture when given, else the repo's t29 store. Fail-open: a
   * missing/corrupt store already degrades to [] inside loadRecords, and an
   * unexpected error is swallowed the same way ("no history").
   */
  private async roiReputationRecords(): Promise<readonly ReputationRecord[]> {
    if (this.roiReputation !== null) return this.roiReputation;
    try {
      this.roiReputation = await loadRecords(resolveReputationStorePath(this.parentCwd));
    } catch {
      this.roiReputation = [];
    }
    return this.roiReputation;
  }

  /**
   * P2.F: build the ROI input for one node. Reputation comes from the t29
   * (repo, host-agent-role) bucket and is trusted only at/above
   * REPUTATION_MIN_SAMPLE — below that the rate/repair/latency fields stay
   * null so the score falls back to its sane defaults (unknown ⇒ spawn).
   * Token and per-token price estimates do not exist pre-run in v1
   * (documented): both stay null. `now` is taken by the gate, never inside
   * the pure module.
   */
  private roiInputFor(
    node: TaskNode,
    racing: readonly TaskNode[],
    records: readonly ReputationRecord[],
    now: number,
  ): SpawnRoiInput {
    let verifiedRate: number | null = null;
    let avgRepairs: number | null = null;
    let latencyMs: number | null = null;
    let sample = 0;
    try {
      const summary = aggregate(
        records,
        { repo: path.basename(this.parentCwd), role: agentForNode(node) },
        now,
      );
      sample = summary.sample;
      if (summary.sample >= REPUTATION_MIN_SAMPLE) {
        verifiedRate = summary.verifiedRate;
        avgRepairs = summary.avgRepairs;
        latencyMs = summary.avgLatencyMs;
      }
    } catch {
      /* fail-open: treat as no history */
    }
    return {
      reputationSample: sample,
      verifiedRate,
      historicalAvgRepairs: avgRepairs,
      estimatedTokens: null,
      costUsdPer1k: null,
      latencyMsEstimate: latencyMs,
      duplicationRisk: duplicationRiskFor(node, racing),
      taskKind: roiTaskKindOf(node.kind),
    };
  }

  /**
   * P2.F: the veto itself. Scores every node about to spawn against
   * ZELARI_KRAKEN_ROI_THRESHOLD (raw env string parsed per admit — invalid ⇒
   * default) and returns the survivors. Vetoed nodes are NOT failed: they are
   * simply not returned, so they stay READY and are re-offered next round,
   * each with a `node_roi_vetoed` radio trail. Fail-open twice over: an error
   * while scoring ONE node spawns that node, and an error that escapes the
   * loop spawns the whole batch — the gate must never break a run.
   */
  private async roiGate(
    spawnList: readonly TaskNode[],
    running: readonly TaskNode[],
  ): Promise<{ spawn: TaskNode[]; vetoed: TaskNode[] }> {
    const spawn: TaskNode[] = [];
    const vetoed: TaskNode[] = [];
    if (spawnList.length === 0) return { spawn, vetoed };
    try {
      const threshold = parseRoiThreshold(process.env.ZELARI_KRAKEN_ROI_THRESHOLD);
      const records = await this.roiReputationRecords();
      const now = Date.now();
      const racing = [...running, ...spawnList];
      for (const node of spawnList) {
        try {
          const input = this.roiInputFor(
            node,
            racing.filter((r) => r.id !== node.id),
            records,
            now,
          );
          const score = this.roiScoreFn(input);
          if (shouldSpawn(score, threshold)) {
            spawn.push(node);
            continue;
          }
          vetoed.push(node);
          const pinned = Number(score.score.toFixed(4));
          this.radio('node_roi_vetoed', {
            description: node.label,
            agent: node.kind,
            detail: `roi gate: spawnScore ${pinned} < threshold ${threshold} (${score.rationaleCode}) — stays READY`,
            ok: true,
            nodeId: node.id,
            spawnScore: pinned,
            threshold,
            rationaleCode: score.rationaleCode,
          });
          this.wb?.logEvent(
            `roi-vetoed ${node.id} "${node.label}" — spawnScore ${pinned} < ${threshold} (${score.rationaleCode}); deferred, not failed`,
          );
        } catch {
          spawn.push(node); // per-node fail-open
        }
      }
    } catch {
      return { spawn: [...spawnList], vetoed: [] }; // whole-gate fail-open
    }
    return { spawn, vetoed };
  }

  /**
   * P2.B: may `node` (held by P2.A/P2.C arbitration) run alongside the racing
   * writers because BOTH sides declare disjoint symbol ownership? Only a pair
   * that actually shares a contested file qualifies; EVERY overlapping racer
   * must verify disjoint — one undecided or conflicting pair keeps the node
   * held. Returns the telemetry anchor of the last verified pair, or null to
   * defer exactly as today.
   */
  private async semanticRescueDecision(
    node: TaskNode,
    racing: readonly TaskNode[],
    ctx: SemanticConflictCtx,
  ): Promise<{
    racerId: string;
    contestedFile: string;
    reasonCode: string;
    symbolsA: string[];
    symbolsB: string[];
  } | null> {
    if (!node.ownedSymbols || node.ownedSymbols.length === 0) return null;
    let verified: {
      racerId: string;
      contestedFile: string;
      reasonCode: string;
      symbolsA: string[];
      symbolsB: string[];
    } | null = null;
    for (const racer of racing) {
      const overlaps = hasWriteOverlap(racer, node, {
        caseInsensitive: this.ownershipCaseFolding,
      });
      if (!overlaps) continue;
      const verdict = await semanticConflictDecision(racer, node, ctx);
      // No shared contested file ⇒ the claims cannot anchor a same-file
      // rescue; treat as undecided (defer) rather than widening on spec faith.
      if (verdict.conflict || verdict.contestedFile === undefined) return null;
      verified = {
        racerId: racer.id,
        contestedFile: verdict.contestedFile,
        reasonCode: verdict.reasonCode,
        symbolsA: [...(racer.ownedSymbols ?? [])],
        symbolsB: [...node.ownedSymbols],
      };
    }
    return verified;
  }

  /**
   * Run one node, tagging the result with its id and converting an unexpected
   * throw into a node failure. The scheduler races these promises, so a
   * rejection would abandon every other in-flight tentacle mid-write; one
   * failed node that the retry/fix machinery can reason about is strictly
   * better than an aborted graph.
   */
  private runNodeSafely(node: TaskNode, graph: TaskGraph): Promise<SettledNode> {
    return this.runNode(node, graph).then(
      (res) => ({ id: node.id, res }),
      (err: unknown) => ({
        id: node.id,
        res: {
          ok: false as const,
          agent: agentForNode(node),
          error: `tentacle threw: ${err instanceof Error ? err.message : String(err)}`,
          cancelled: true,
        },
      }),
    );
  }

  /** Run one node: dispatch to the merge handler for `merge` nodes, else a tentacle. */
  private async runNode(node: TaskNode, graph: TaskGraph): Promise<TentacleResult> {
    const startedAt = Date.now();
    try {
      return await this.runNodeInner(node, graph);
    } finally {
      this.durationsMs.set(node.id, Date.now() - startedAt);
      this.nodeControllers.delete(node.id);
    }
  }

  private async runNodeInner(node: TaskNode, graph: TaskGraph): Promise<TentacleResult> {
    this.radio('node_start', { description: node.label, agent: node.kind });

    if (node.kind === 'merge') {
      return this.runMergeNode(node, graph);
    }

    // A rework edits the worktree its writer already produced (see
    // spawnReworkPair) — it must not open a second one on the same scope.
    const isRework = this.reworks.has(node.id);
    const usesWorktree = (node.kind === 'general' || node.kind === 'fix') && !isRework;
    // Map script-runtime kinds onto the host's `TaskAgentKind`. Reviewer
    // kinds (verify, spec, conformance) all run as 'verify' agents under
    // the hood — the persona is enforced at the prompt level, not the
    // runtime level. Pillar 2 will lift this once we have per-persona
    // system prompt injection in `runTentacle`.
    const agent: TaskAgentKind =
      node.kind === 'fix'
        ? 'general'
        : node.kind === 'spec' || node.kind === 'conformance'
          ? 'verify'
          : node.kind;
    const controller = new AbortController();
    // Registered so a cancelled run can reach in and stop this tentacle
    // instead of waiting for it to finish on its own.
    this.nodeControllers.set(node.id, controller);
    if (this.aborted) controller.abort();
    // Hand the sub-agent what its dependencies actually concluded — the whole
    // point of the dep edge (see buildUpstreamContext).
    const upstream = buildUpstreamContext(graph, node);
    // A verify inspects the tree its writer wrote in; a rework edits that same
    // tree. Both resolve to the worktree recorded behind their deps.
    const inheritedCwd =
      node.kind === 'verify' || isRework
        ? this.inheritedWorktreeCwdFor(node, graph)
        : undefined;
    const runOpts: RunTentacleOptions = {
      // `allowWorktree: false` is what actually stops a rework from opening
      // its own worktree: creation is driven by the agent kind ('general')
      // inside runTentacle, not by anything the executor passes per-call.
      deps: isRework ? { ...this.deps, allowWorktree: false } : this.deps,
      args: {
        description: node.label,
        prompt: upstream ? `${node.prompt}\n${upstream}` : node.prompt,
        scope: node.scope,
        acceptance: node.acceptance,
      },
      agent,
      thoroughness: thoroughnessForKind(node.kind),
      parentCwd: this.parentCwd,
      ...(inheritedCwd ? { cwdOverride: inheritedCwd } : {}),
      sessionId: this.sessionId,
      // Defer merge for writers so the executor controls merge ordering
      // (Correction 4); explore/verify/rework never create a worktree.
      deferMerge: usesWorktree,
      graphId: graph.id,
      nodeId: node.id,
      signal: controller.signal,
    };
    const runOnce = (): Promise<TentacleResult> =>
      this.withNodeTimeout(this.runTentacleFn(runOpts), agent, controller);

    // P2.D: transactional writers (opt-in) — checkpoint the parent tree
    // before the run, roll it back if the node fails, keep the checkpoint as
    // a recovery point (correlated to graph/node) on success. Explore,
    // verify, merge and rework paths are never wrapped.
    if (!this.transactional || node.kind !== 'general') {
      const res = await runOnce();
      if (res.ok && usesWorktree) {
        this.nodeRunState.set(node.id, { worktreeHandle: res.worktreeHandle });
      }
      return res;
    }
    const tx = await runTransactional(
      { cwd: this.parentCwd, taskId: graph.id, nodeId: node.id, label: node.label },
      async () => {
        const res = await runOnce();
        // A failed tentacle RESOLVES with ok:false — map it to a throw so
        // runTransactional sees a transaction failure and rolls back.
        if (!res.ok) throw new Error(res.error);
        return res;
      },
    );
    if (tx.outcome === 'rolledback') {
      this.radio('node_rolled_back', {
        description: node.label,
        agent: node.kind,
        detail: tx.error ?? 'node failed; workspace rolled back',
        ok: false,
      });
      this.wb?.logEvent(
        `rolled back ${node.id} "${node.label}" — ${tx.error ?? 'node failed'}`,
      );
      // The ordinary failure path: retry (if budgeted) re-runs from the clean
      // checkpoint state. No `cancelled` field — the tentacle unwound, so a
      // re-run is safe.
      return { ok: false, agent, error: tx.error ?? `node "${node.label}" failed` };
    }
    const res: TentacleResult | undefined = tx.value;
    if (!res) {
      // Contractually unreachable (success/passthrough carry the run's
      // result); an honest failure beats returning undefined.
      return { ok: false, agent, error: tx.note ?? 'transactional run produced no result' };
    }
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
   * The worktree a node should run in, inherited from the writer behind it.
   *
   * For a `verify`: verification happens BEFORE the merge node, so when its
   * writer worked in an isolated worktree the changes are not in the parent
   * tree yet — a verify tentacle pointed at `parentCwd` was inspecting a tree
   * that provably did not contain the work it was asked to check, and reported
   * it missing.
   *
   * For a rework: the same tree, for the stronger reason that writing anywhere
   * else would strand the round on a second branch.
   *
   * Returns undefined when there is no single tree: no worktrees (isolation
   * disabled — the writers edited the parent tree directly), or several
   * distinct ones, in which case no single cwd is correct and the parent tree
   * is the honest default.
   */
  private inheritedWorktreeCwdFor(node: TaskNode, graph: TaskGraph): string | undefined {
    const paths = new Set(
      this.collectWorktreeSources(node, graph).map((s) => s.handle.path),
    );
    return paths.size === 1 ? [...paths][0] : undefined;
  }

  /**
   * Resolve the deferred worktrees produced behind a node's dependencies, in
   * ancestors-first order. Used to decide what a `merge` node must merge, and
   * which tree a `verify` node should actually inspect.
   *
   * A merge node's direct deps are NOT the writers: `buildGraphFromPlan`
   * injects a `verify` node after every `general` node and points the merge at
   * those verifies, while worktree handles are recorded against the writer
   * node ids. Looking only at direct deps therefore found nothing to merge and
   * silently reported success while every tentacle's work stayed stranded on
   * its branch. Walk up through non-writer deps until the writers are found.
   *
   * Post-order so a writer that depends on another writer merges after it (the
   * later branch was cut from a HEAD that already contained the earlier work).
   * `merge` nodes terminate the walk: another merge already owns its subtree.
   */
  private collectWorktreeSources(
    node: TaskNode,
    graph: TaskGraph,
  ): Array<{ id: string; handle: WorktreeHandle }> {
    const out: Array<{ id: string; handle: WorktreeHandle }> = [];
    const seen = new Set<string>();

    const visit = (id: string): void => {
      if (seen.has(id)) return;
      seen.add(id);
      const n = graph.nodes.get(id);
      if (!n || n.kind === 'merge') return;
      for (const dep of n.deps) visit(dep);
      const handle = this.nodeRunState.get(id)?.worktreeHandle;
      if (handle) out.push({ id, handle });
    };

    for (const depId of node.deps) visit(depId);
    return out;
  }

  /**
   * Sequentially merge every deferred worktree this node covers (in
   * ancestors-first order) into parent HEAD. Nodes without a recorded worktree
   * handle (worktree isolation disabled, or a read-only node) are a no-op. On
   * conflict the branch is kept and the conflict is surfaced in the merge
   * node's error — remaining sources still attempt to merge (independent
   * branches shouldn't be blocked by one conflict).
   */
  private async runMergeNode(node: TaskNode, graph: TaskGraph): Promise<TentacleResult> {
    const conflicts: string[] = [];
    const merged: string[] = [];

    for (const { id: depId, handle } of this.collectWorktreeSources(node, graph)) {
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
        // The branch is merged (and, unless KEEP is set, the worktree is gone).
        // Drop the handle so a second merge node covering the same ancestor
        // cannot try to merge a branch that no longer exists.
        this.nodeRunState.set(depId, { worktreeHandle: null });
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
    this.applyResultInner(graph, node, res);
    this.recordNodeReputation(node, res);
  }

  private applyResultInner(graph: TaskGraph, node: TaskNode, res: TentacleResult): void {
    if (res.ok) {
      if (res.memoryId) this.memoryIds.set(node.id, res.memoryId);
      node.status = 'done';
      node.result = res.result;
      this.radio('node_end', { description: node.label, agent: node.kind, ok: true });
      this.wb?.markEnd(node.id, {
        status: 'done',
        durationMs: this.durationsMs.get(node.id),
        // Reviewers surface verdict + Bennett weakness; writers don't.
        ...(this.isReviewerKind(node.kind) &&
        typeof node.result === 'string' &&
        node.result.length > 0
          ? { findings: node.result }
          : {}),
        ...(res.model && res.model !== 'n/a' ? { model: res.model } : {}),
      });
      this.reconcileRepairedNode(graph, node);
      // A verify that RAN successfully is not the same thing as work that
      // PASSED. Read what it actually concluded.
      if (node.kind === 'verify') this.applyVerifyVerdict(graph, node);
      return;
    }

    node.error = res.error;

    // A cancelled run must not retry or spawn repairs: the caller asked for
    // the graph to stop, and re-spawning work is the opposite of that.
    if (this.aborted) {
      node.status = 'error';
      this.radio('node_end', {
        description: node.label,
        agent: node.kind,
        detail: res.error,
        ok: false,
      });
      this.wb?.markEnd(node.id, {
        status: 'error',
        error: res.error,
        durationMs: this.durationsMs.get(node.id),
      });
      return;
    }

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
      this.wb?.markEnd(node.id, {
        status: 'error',
        error: res.error,
        durationMs: this.durationsMs.get(node.id),
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
      // Back to `pending` in the workbench too; the re-admission marks it
      // running again.
      this.wb?.markEnd(node.id, { status: 'pending' });
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
      this.wb?.markEnd(node.id, {
        status: 'error',
        error: res.error,
        durationMs: this.durationsMs.get(node.id),
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
    this.wb?.markEnd(node.id, {
      status: 'error',
      error: res.error,
      durationMs: this.durationsMs.get(node.id),
    });
  }

  /**
   * t29 (§15): append ONE reputation record for a settled node run — the
   * minimal recorder hook. Only terminal states are recorded (success, or a
   * failure that consumed the retry budget / got its fix node): retries leave
   * the node `pending` and cancelled/unconfirmed runs are skipped, because
   * cancellation and re-entry are not model signals. Repo = basename of the
   * parent cwd; role = host agent kind (agentForNode); model when the result
   * carries one ('n/a' merge pseudo-model ⇒ null); provider is NOT carried by
   * TentacleResult so it records as null (documented v1 limitation). FAILOPEN:
   * every failure path is swallowed — reputation must never break a run.
   */
  private recordNodeReputation(node: TaskNode, res: TentacleResult): void {
    try {
      if (!res.ok) {
        if (this.aborted || res.cancelled === true || res.cancelled === false) return;
        // Retry re-queues the node ('pending'): its final run records the
        // whole story via retryCount, so intermediate attempts are not rows.
        if (node.status === 'pending') return;
      }
      const model = res.ok && res.model && res.model !== 'n/a' ? res.model : null;
      const reviewerVerdict =
        res.ok && this.isReviewerKind(node.kind) && typeof node.result === 'string' && node.result.length > 0
          ? parseVerifyVerdict(node.result).verdict
          : null;
      const record = reputationRecordFromNodeRun({
        repo: path.basename(this.parentCwd),
        role: agentForNode(node),
        kind: node.kind,
        ok: res.ok,
        reviewerVerdict,
        repairCount: node.retryCount,
        model,
        provider: null, // TentacleResult carries no provider identity (t29 v1).
        costUsd:
          res.ok && model && res.usage
            ? calculateCost(
                model,
                res.usage.promptTokens,
                res.usage.completionTokens,
                res.usage.cachedPromptTokens ?? 0,
              )
            : null,
        latencyMs: this.durationsMs.get(node.id) ?? null,
      });
      const storePath = resolveReputationStorePath(this.parentCwd);
      void appendRecord(storePath, record)
        .then(() => pruneStore(storePath, DEFAULT_MAX_RECORDS))
        .catch(() => {
          /* fail-open */
        });
    } catch {
      /* fail-open: reputation must never break a run */
    }
  }

  /**
   * t29 (§16): load the repo's reputation store once per run and publish it
   * as the verifier-routing source, so the NEXT advisory review inside this
   * process consults real history. Passive + fail-open: a missing/corrupt
   * store yields an empty list, which keeps t21 heuristics verbatim.
   */
  private async refreshReputationSource(): Promise<void> {
    try {
      setReputationSource(await loadRecords(resolveReputationStorePath(this.parentCwd)));
    } catch {
      /* fail-open */
    }
  }

  private async linkMemoryGraph(graph: TaskGraph, converged: boolean): Promise<void> {
    const memory = this.deps.memoryService;
    if (!memory || this.deps.memoryAutoWrite === false) return;
    try {
      for (const node of graph.nodes.values()) {
        const nodeMemoryId = this.memoryIds.get(node.id);
        if (!nodeMemoryId) continue;
        for (const dependencyId of node.deps) {
          const dependencyMemoryId = this.memoryIds.get(dependencyId);
          if (!dependencyMemoryId) continue;
          if (node.kind === 'verify') {
            const verdict = parseVerifyVerdict(node.result).verdict;
            await memory.connect({
              from: dependencyMemoryId,
              to: nodeMemoryId,
              relation: verdict === 'pass'
                ? 'validated_by'
                : verdict === 'fail'
                  ? 'invalidated_by'
                  : 'related_to',
              createdBy: 'kraken-orchestrator',
            });
          } else {
            await memory.connect({
              from: nodeMemoryId,
              to: dependencyMemoryId,
              relation: 'derived_from',
              createdBy: 'kraken-orchestrator',
            });
          }
        }
      }
      const counts = countByStatus(graph) as unknown as Record<string, number>;
      const outcome = await memory.remember({
        kind: converged ? 'outcome' : 'failure',
        content:
          `Kraken graph for “${this.goal ?? graph.id}” ${converged ? 'converged' : 'did not converge'}: ` +
          `${counts.done ?? 0} done, ${counts.error ?? 0} error, ${counts.skipped ?? 0} skipped.`,
        importance: 0.8,
        confidence: converged ? 0.9 : 0.8,
        tags: ['kraken', 'graph-outcome'],
        source: { agent: 'kraken-orchestrator', sessionId: this.sessionId },
        metadata: { graphId: graph.id, converged, counts, writeClass: 'auto' },
        writeClass: 'auto',
      });
      for (const memoryId of this.memoryIds.values()) {
        await memory.connect({
          from: outcome.id,
          to: memoryId,
          relation: 'derived_from',
          createdBy: 'kraken-orchestrator',
        });
      }
      await memory.consolidate({
        source: { agent: 'kraken-orchestrator', sessionId: this.sessionId },
        minOccurrences: 2,
      });
    } catch {
      // Memory failure never changes graph status or prevents snapshotting.
    }
  }

  /**
   * A `fix` node just completed the work its failed predecessor could not.
   * That unit of work IS done — but the predecessor was left terminally
   * `error`, and since `isConverged` requires every node to be `done`/
   * `skipped`, a fully repaired graph reported "did not converge" and listed
   * the repaired node under `failedNodeIds`. The cross-run snapshot then told
   * the next planner to redo work the fix had already completed.
   *
   * Marking it `done` has no scheduling effect (dependents were re-pointed at
   * the fix when it was spawned) — it is purely how the run is reported. The
   * original failure stays visible as the separate `fix: …` node and in the
   * repaired node's result line.
   */
  private reconcileRepairedNode(graph: TaskGraph, fixNode: TaskNode): void {
    const failedId = this.repairs.get(fixNode.id);
    if (!failedId) return;
    const failed = graph.nodes.get(failedId);
    if (!failed || failed.status !== 'error') return;

    const original = failed.error ? ` (original failure: ${failed.error})` : '';
    failed.status = 'done';
    failed.result = `repaired by "${fixNode.label}"${original}${
      fixNode.result ? `: ${fixNode.result}` : ''
    }`;
    // Clear the error: the snapshot lists a `done` node under "Already
    // completed — do NOT redo this work", and a trailing error message there
    // reads as if it still needs repair.
    failed.error = undefined;
    this.radio('node_end', {
      description: failed.label,
      agent: failed.kind,
      detail: `repaired by ${fixNode.id}`,
      ok: true,
    });
    this.wb?.markEnd(failed.id, {
      status: 'done',
      durationMs: this.durationsMs.get(failed.id),
    });
  }

  /**
   * Act on what a completed `verify` node concluded.
   *
   * The verify itself stays `done` either way — it did its job, and doing it
   * well means being free to say "no". A FAIL instead sends the WRITER back
   * through a bounded rework round.
   *
   * Without this the verdict text was never read: a verify that reported the
   * work as wrong was recorded exactly like one that reported it correct, the
   * graph converged over the defect, and the only iteration the engine could
   * do was on execution failure. An `unknown` verdict (no parseable trailer)
   * is deliberately non-blocking — a prompt drift must not be able to wedge
   * every graph — but it is recorded, because a gate that has silently stopped
   * working is worse than no gate.
   */
  private applyVerifyVerdict(graph: TaskGraph, verify: TaskNode): void {
    const { verdict, findings } = parseVerifyVerdict(verify.result);
    if (verdict === 'pass') return;

    const writer = this.writerBehind(verify, graph);
    if (!writer) return; // nothing to send back to

    // Bennett's Razor meter (opt-in): when ZELARI_KRAKEN_WEAKNESS_METER=1,
    // fire a non-blocking LLM call to refine the persona verdict with
    // a principled weakness score. The result lands in the radio
    // stream as `node_meter` so the desktop can surface a "tightly
    // asserted PASS" vs "loosely claimed PASS" distinction. The local
    // heuristic already produced a score; the meter just refines it.
    void this.maybeRunWeaknessMeter(verify, verdict);

    if (verdict === 'unknown') {
      this.unresolved.push({
        nodeId: writer.id,
        label: writer.label,
        reason: 'unknown',
        findings: findings || '(verify produced no parseable VERDICT line)',
      });
      return;
    }

    // A cancelled run must not spawn new work, and a lineage that has spent
    // its rounds is done being reworked.
    const root = this.reviewLineage.get(writer.id) ?? writer.id;
    const spent = this.reviewRounds.get(root) ?? 0;
    if (this.aborted || spent >= this.maxReviewRounds) {
      this.unresolved.push({
        nodeId: writer.id,
        label: writer.label,
        reason: 'fail',
        findings,
      });
      // Keep the unresolved verdict attached to the node too, so the digest,
      // the snapshot and any reader of the graph see it in the same place the
      // repaired-node marker lives.
      writer.result =
        `${writer.result ?? ''}\n\n[accepted with unresolved verify findings from ` +
        `"${verify.label}"]${findings ? `: ${firstLine(findings)}` : ''}`.trim();
      this.radio('node_end', {
        description: writer.label,
        agent: writer.kind,
        detail: this.aborted
          ? 'verify FAIL left unresolved (run cancelled)'
          : `verify FAIL left unresolved (rework budget ${this.maxReviewRounds} spent)`,
        ok: false,
      });
      return;
    }

    this.reviewRounds.set(root, spent + 1);
    this.spawnReworkPair(graph, writer, verify, findings, root, spent + 1);
  }

  /**
   * The writer whose work a `verify` node judged.
   *
   * Walks up through non-writer deps, the same shape `collectWorktreeSources`
   * relies on: a verify's dep is normally its writer directly, but after a
   * rework round the chain is writer → verify → rework → verify, and the
   * rework (a `fix` node) is itself the writer to send back.
   */
  private writerBehind(verify: TaskNode, graph: TaskGraph): TaskNode | undefined {
    const seen = new Set<string>();
    const visit = (id: string): TaskNode | undefined => {
      if (seen.has(id)) return undefined;
      seen.add(id);
      const n = graph.nodes.get(id);
      if (!n || n.kind === 'merge') return undefined;
      if (n.kind === 'general' || n.kind === 'fix') return n;
      for (const dep of n.deps) {
        const found = visit(dep);
        if (found) return found;
      }
      return undefined;
    };
    for (const depId of verify.deps) {
      const found = visit(depId);
      if (found) return found;
    }
    return undefined;
  }

  /**
   * Send a writer's work back for one more round: a rework node carrying the
   * verify's findings, plus a fresh verify to judge the result.
   *
   * The rework runs INSIDE the writer's worktree instead of creating one of
   * its own. Two worktrees for one scope means two branches, and the merge
   * node walks up to the writer — so a rework on its own branch would be
   * merged never or twice, exactly the stranded-work failure the merge fix
   * addressed. `allowWorktree: false` on this node's deps suppresses creation,
   * and `cwdOverride` (resolved via {@link inheritedWorktreeCwdFor}) points it
   * at the existing tree; the handle stays registered against the writer.
   *
   * Acyclicity is preserved by construction: both new nodes point only at
   * nodes that already exist, and the rewiring moves an existing edge forward
   * along the chain rather than back into it.
   */
  private spawnReworkPair(
    graph: TaskGraph,
    writer: TaskNode,
    verify: TaskNode,
    findings: string,
    root: string,
    round: number,
  ): void {
    // Named after the lineage root, so round 2 of g1 is `rework-g1-2` rather
    // than a nested `rework-rework-g1-1-1`.
    const reworkId = `rework-${root}-${round}`;
    const reworkNode: TaskNode = {
      id: reworkId,
      kind: 'fix',
      label: `rework: ${writer.label}`,
      prompt:
        `A reviewer inspected this work on disk and REJECTED it. Address every finding below, ` +
        `then leave the work in a state that satisfies the original task.\n\n` +
        `## Original task\n${writer.prompt}\n\n` +
        `## Reviewer findings (these are what must change)\n${
          findings || '(the reviewer reported FAIL without detail)'
        }`,
      ...(writer.scope ? { scope: writer.scope } : {}),
      ...(writer.acceptance ? { acceptance: writer.acceptance } : {}),
      // The verify is already `done`, so the rework is immediately ready.
      deps: [verify.id],
      status: 'pending',
      retryCount: 0,
      maxRetries: 0,
    };
    graph.nodes.set(reworkId, reworkNode);
    this.reworks.set(reworkId, writer.id);
    this.reviewLineage.set(reworkId, root);

    const reVerifyId = `verify-${reworkId}`;
    const reVerifyNode: TaskNode = {
      id: reVerifyId,
      kind: 'verify',
      label: `verify: ${writer.label} (rework ${round})`,
      prompt: verify.prompt,
      deps: [reworkId],
      status: 'pending',
      retryCount: 0,
      maxRetries: verify.maxRetries,
    };
    graph.nodes.set(reVerifyId, reVerifyNode);
    this.wb?.setNodes([this.toWorkbenchNode(reworkNode), this.toWorkbenchNode(reVerifyNode)]);

    // Whatever waited on the old verify (typically the merge node) must now
    // wait on the new one, or it would merge the branch mid-rework.
    for (const other of graph.nodes.values()) {
      if (other.id === reworkId || other.id === reVerifyId) continue;
      if (other.deps.includes(verify.id)) {
        other.deps = other.deps.map((d) => (d === verify.id ? reVerifyId : d));
      }
    }

    this.radio('node_fix', {
      description: reworkNode.label,
      agent: 'fix',
      detail: `verify FAIL on "${writer.label}" — rework round ${round}/${this.maxReviewRounds}`,
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
    this.wb?.setNodes([this.toWorkbenchNode(fixNode)]);
    this.repairs.set(fixId, failed.id);

    // Downstream dependents wait on the fix attempt INSTEAD of the failed
    // node (not in addition to it): the failed node is terminally `error` and
    // will never run again, so leaving it in `deps` would strand them forever.
    // (If the fix succeeds, `reconcileRepairedNode` marks the failed node
    // `done` for reporting — after this rewiring, and with no effect on it.)
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
    kind:
      | 'node_start'
      | 'node_end'
      | 'node_retry'
      | 'node_fix'
      | 'node_deferred'
      | 'node_worktree_scheduled'
      | 'node_semantic_admitted'
      | 'node_roi_vetoed'
      | 'node_rolled_back'
      | 'graph_converged'
      | 'graph_failed'
      | 'node_meter',
    fields: {
      description: string;
      agent?: string;
      detail?: string;
      ok?: boolean;
      nodeId?: string;
      overlapScore?: number;
      rationaleCode?: string;
      runningNode?: string;
      contestedFile?: string;
      spawnScore?: number;
      threshold?: number;
      symbolsA?: string[];
      symbolsB?: string[];
    },
  ): void {
    appendKrakenRadio(this.parentCwd, this.sessionId, {
      kind,
      agent: fields.agent ?? 'graph',
      description: fields.description,
      ...(fields.detail !== undefined ? { detail: fields.detail } : {}),
      ...(fields.ok !== undefined ? { ok: fields.ok } : {}),
      ...(fields.nodeId !== undefined ? { nodeId: fields.nodeId } : {}),
      ...(fields.overlapScore !== undefined ? { overlapScore: fields.overlapScore } : {}),
      ...(fields.rationaleCode !== undefined ? { rationaleCode: fields.rationaleCode } : {}),
      ...(fields.runningNode !== undefined ? { runningNode: fields.runningNode } : {}),
      ...(fields.contestedFile !== undefined ? { contestedFile: fields.contestedFile } : {}),
      ...(fields.spawnScore !== undefined ? { spawnScore: fields.spawnScore } : {}),
      ...(fields.threshold !== undefined ? { threshold: fields.threshold } : {}),
      ...(fields.symbolsA !== undefined ? { symbolsA: fields.symbolsA } : {}),
      ...(fields.symbolsB !== undefined ? { symbolsB: fields.symbolsB } : {}),
    });
  }

  /**
   * Bennett's Razor meter (Slice L/N+3 wiring): when the env flag is
   * set, fire a non-blocking LLM call to refine the persona verdict's
   * weakness score. The local heuristic already produced a score in
   * `parsePersonaVerdict`; the meter just refines it. Results land in
   * the radio stream as a `node_meter` event so the desktop / tail
   * can surface the distinction between a "tightly asserted" PASS
   * (specificity > 0.6) and a "loosely claimed" one (specificity < 0.3).
   *
   * No-op when:
   *   - the meter is disabled (default)
   *   - the result text is empty
   *   - the meter call fails (silent: the local score is good enough)
   *
   * @since v1.31.x
   */
  private async maybeRunWeaknessMeter(
    verify: TaskNode,
    verdict: 'pass' | 'fail' | 'unknown',
  ): Promise<void> {
    // Lazy import: keep the executor's cold-start path fast and avoid
    // a hard dep on the meter module's provider/key stack when the
    // meter is disabled (which is the default).
    const text = typeof verify.result === 'string' ? verify.result : '';
    if (text.length === 0) return;
    let meter: typeof import('./weaknessMeter.js').measureWeaknessViaLLM | undefined;
    try {
      ({ measureWeaknessViaLLM: meter } = await import('./weaknessMeter.js'));
    } catch {
      return;
    }
    if (!meter) return;
    const outcome = await meter(text);
    if (!outcome) return; // disabled or failed — silent
    this.radio('node_meter', {
      description: `meter: ${verify.id}`,
      agent: 'weakness-meter',
      detail: `v=${verdict} specificity=${outcome.meter.specificity.toFixed(2)} ` +
        `weakness=${outcome.weakness.toFixed(2)} ` +
        `model=${outcome.model} ` +
        `dur=${outcome.durationMs}ms ` +
        `assumptions=${outcome.meter.assumptions.length}`,
      ok: true,
    });
  }
}
