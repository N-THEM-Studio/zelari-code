/**
 * Kraken script runtime — public types.
 *
 * A Kraken "script plan" is a TypeScript module the planner emits (or a user
 * hands in) that imports the SDK from `@zelari/kraken-runtime` and calls
 * `tentacle()`, `merge()`, `checkpoint()`, etc. The runtime compiles the
 * module with esbuild (CLI side), loads it in a Node `vm` context with a
 * capability-based sandbox, and runs it. Every call into the SDK is a
 * bridge from the sandboxed script to the parent process — there is no
 * direct filesystem, process, or network access in the script.
 *
 * Safety invariants (see F1.1 in `.zelari/docs/kraken-best-in-class-roadmap.md`):
 *   - The script cannot read `process.env` or `fs` outside the SDK.
 *   - Every `tentacle()` call increments a counter; the run aborts past
 *     `MAX_TENTACLES` (default 200) regardless of what the script does.
 *   - The script runs under a wall-clock budget (`ZELARI_KRAKEN_PLAN_TIMEOUT_MS`,
 *     default 30 minutes) enforced by the `vm` timeout.
 *   - `merge()` is one-shot per plan: a second call throws `PlanError` and
 *     the run is settled.
 *
 * @since Kraken v1.30.x — workflow script runtime (F1.1)
 */

import type { z } from 'zod';
import type { TaskNodeKind, TaskNodeStatus } from '../graph.js';

/** A node the script plans to spawn. Mirrors the JSON-DAG shape for parity. */
export interface TentacleOptions<T = unknown> {
  /** What kind of subagent this is. */
  kind: TaskNodeKind;
  /** Short label for status / radio (max 200 chars). */
  label: string;
  /** Full self-contained prompt handed to the subagent. */
  prompt: string;
  /** Path/glob allowlist. Required for parallel writers. */
  scope?: string[];
  /** Acceptance checklist enforced by the verify tentacle. */
  acceptance?: string[];
  /** Upstream tentacle refs whose results are injected as context. */
  deps?: TentacleRef[];
  /**
   * Optional Zod schema. If set, the subagent is asked to emit JSON matching
   * the schema as its final message; the parsed result is exposed as
   * `TentacleRef.result`. Use for structured hand-offs between tentacles.
   */
  outputSchema?: z.ZodType<T>;
  /** Tool-call budget. Default: `deep` for writers, `medium` for readers. */
  thoroughness?: 'quick' | 'medium' | 'deep';
  /** Model override. Default: routed by `krakenModel` per kind. */
  model?: string;
  /** Max retries before the node is left `error` (no fix-node spawn). */
  maxRetries?: number;
  /** Wall-clock cap (ms) for this single tentacle. 0 disables. */
  maxRuntimeMs?: number;
}

/**
 * A reference to a tentacle the script spawned. The `result` is populated
 * only when the subagent emitted a parseable JSON matching `outputSchema`;
 * otherwise the raw `findings` text is the fallback.
 */
export interface TentacleRef<T = unknown> {
  id: string;
  kind: TaskNodeKind;
  label: string;
  status: TaskNodeStatus;
  /** Parsed JSON if `outputSchema` was set and the subagent emitted it. */
  result?: T;
  /** Raw text conclusion (always populated, capped to `MAX_FINDINGS_CHARS`). */
  findings: string;
  /** Verdict trailer for `verify` / `spec` / `conformance` tentacles. */
  verdict?: 'pass' | 'fail' | 'unknown';
  scope?: string[];
  durationMs?: number;
  worktree?: string | null;
}

/** How a `merge()` call should land the worktrees in the parent HEAD. */
export type MergeStrategy = 'squash' | 'squash-sequential' | 'rebase' | 'manual';

export interface MergeOptions {
  strategy?: MergeStrategy;
  message?: string;
  /** Delete the worktrees after a successful merge. Default: true. */
  cleanup?: boolean;
}

/** Per-tentacle outcome from the runtime's perspective. */
export interface MergeResult {
  merged: string[];
  conflicts: { nodeId: string; reason: string }[];
  /** True when every input tentacle was merged without conflict. */
  ok: boolean;
}

/** Snapshot of the running plan, persisted as JSON. */
export interface PlanSnapshot {
  graphId: string;
  goal: string;
  takenAt: string;
  completed: TentacleRef[];
  inFlight: TentacleRef[];
  failed: TentacleRef[];
  /** Tentacles the script already declared but not yet started. */
  pending: TentacleRef[];
}

/** What the user (or a hook) can emit to the radio / workbench. */
export interface EmitPayload {
  kind: string;
  detail?: string;
  data?: Record<string, unknown>;
}

/** Error categories the script runtime can raise. */
export type PlanErrorKind =
  | 'budget_exceeded' // tentacle cap or wall-clock
  | 'merge_already_done' // second merge() call
  | 'merge_conflict' // unrecoverable git conflict
  | 'compile_error' // the script didn't type-check / bundle
  | 'runtime_error' // the script threw
  | 'sandbox_breach' // the script tried to access a forbidden capability
  | 'cancelled'; // abort signal fired

/** Structured error from the runtime; scripts should not throw raw values. */
export class PlanError extends Error {
  override readonly name = 'PlanError';
  readonly kind: PlanErrorKind;
  readonly cause?: unknown;
  constructor(kind: PlanErrorKind, message: string, cause?: unknown) {
    super(message);
    this.kind = kind;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Capabilities injected into the script sandbox. Pure values + functions. */
export interface PlanCapabilities {
  tentacle<T = unknown>(opts: TentacleOptions<T>): Promise<TentacleRef<T>>;
  /** Wait for N tentacles to complete (parallel); returns the same refs typed. */
  barrier<T extends readonly TentacleRef[]>(refs: T): Promise<{ -readonly [K in keyof T]: T[K] }>;
  /** Race N tentacles; first to complete wins, others are cancelled. */
  race<T extends readonly TentacleRef[]>(
    refs: T,
  ): Promise<T[number]>;
  /** Bounded loop helper. Throws PlanError('budget_exceeded') past `maxIter`. */
  while_<T>(cond: () => boolean | Promise<boolean>, body: () => Promise<T>, maxIter: number): Promise<T[]>;
  until<T>(cond: () => boolean | Promise<boolean>, body: () => Promise<T>, maxIter: number): Promise<T[]>;
  /** Sequential merge of N worktrees into the parent HEAD. */
  merge(refs: readonly TentacleRef[], opts?: MergeOptions): Promise<MergeResult>;
  /** Snapshot the current plan state to `.zelari/kraken/snapshots/<id>.json`. */
  checkpoint(label?: string): Promise<PlanSnapshot>;
  /** Structured log line to the radio + workbench. */
  log(msg: string, data?: Record<string, unknown>): void;
  /** Emit a custom radio event for downstream tools. */
  emit(payload: EmitPayload): void;
  /** Read-only access to the plan-level context (graph id, goal, etc.). */
  getContext(): PlanContext;
  /** Cross-session message: enqueue a message for `peerId` (a TentacleRef). */
  sendTo(peerId: string, payload: EmitPayload): void;
}

/** Read-only metadata exposed to the script via `getContext()`. */
export interface PlanContext {
  graphId: string;
  goal: string;
  parentCwd: string;
  sessionId: string;
  /** Tentacles emitted so far, by id. */
  tentacles: ReadonlyMap<string, TentacleRef>;
  /** Tentacle cap (`ZELARI_KRAKEN_MAX_TENTACLES`, default 200). */
  maxTentacles: number;
  /** Wall-clock budget for the whole plan (ms). */
  planTimeoutMs: number;
}

/** Bridge between the host (executor) and the script runtime. */
export interface PlanHostBridge {
  /**
   * Run one tentacle, returning the raw host result. The runner turns this
   * into a `TentacleRef` and parses verdicts where appropriate.
   *
   * `worktree` is the worktree path the host created for this tentacle, or
   * `null` if none (read-only kinds). The script runtime uses it to drive
   * `merge()` later.
   */
  runTentacle(args: {
    node: TentacleOptions;
    parentCwd: string;
    sessionId: string;
  }): Promise<HostTentacleResult>;
  /** Merge N worktrees into the parent HEAD, sequentially. */
  mergeWorktrees(args: {
    refs: readonly TentacleRef[];
    parentCwd: string;
    strategy: MergeStrategy;
    message?: string;
    cleanup?: boolean;
  }): Promise<MergeResult>;
  /** Append a structured log line to the radio + workbench. */
  log(line: string): void;
  /** Persist a snapshot JSON to disk. */
  saveSnapshot(snapshot: PlanSnapshot, dir: string): Promise<string>;
  /** Read the abort signal; the script should respect it between awaits. */
  signal(): AbortSignal | undefined;
}

/** Raw tentacle outcome from the host. The runner wraps this in a
 *  `TentacleRef` and stashes it for snapshot / merge. */
export interface HostTentacleResult {
  ok: boolean;
  /** Subagent's final text conclusion. Undefined on failure. */
  result?: string;
  /** Error message. Undefined on success. */
  error?: string;
  /** Wall-clock duration (ms). Optional; the host may not measure this. */
  durationMs?: number;
  /** Worktree path the host created, or null. */
  worktree?: string | null;
}

/** What `runScriptPlan` returns to the executor — the same shape the JSON
 *  DAG path returns, so the executor doesn't need to special-case the two. */
export interface ScriptRunResult {
  /** All tentacles that ran, keyed by id. */
  tentacles: ReadonlyMap<string, TentacleRef>;
  /** Number of `merge()` calls made. 0 = never merged, ≥1 = merged at least once. */
  mergeCount: number;
  /** Aggregate verdict surfaced to the workbench / digest. */
  converged: boolean;
  /** When the run stopped because the abort signal fired. */
  cancelled: boolean;
  /** Wall-clock duration of the whole plan (ms). */
  durationMs: number;
  /** Any unresolved findings (verify FAIL with rework budget spent, etc.). */
  unresolvedFindings: { nodeId: string; label: string; reason: string; findings: string }[];
}
