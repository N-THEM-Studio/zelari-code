/**
 * Kraken script runtime — runner.
 *
 * The `ScriptRunner` is the host-side orchestrator that owns the script's
 * lifecycle: it builds the `PlanCapabilities` object exposed as
 * `__zelari_sdk__` in the sandbox, enforces the tentacle and merge budgets,
 * tracks every tentacle for snapshotting, and converts the host's
 * `TentacleResult` into the script's `TentacleRef`.
 *
 * It does NOT itself compile the bundle (that's the CLI side; see
 * `src/cli/kraken/runtime/compile.ts`) and does NOT itself run the
 * sandbox (that's `sandbox.ts`). It only wires the two together.
 *
 * @since Kraken v1.30.x — workflow script runtime (F1.1)
 */

import { MAX_FINDINGS_CHARS } from '../verdict.js';
import { isReviewerKind, defaultPersonaParse } from '../personas/index.js';
import {
  PlanError,
  type PlanCapabilities,
  type PlanContext,
  type PlanHostBridge,
  type PlanSnapshot,
  type ScriptRunResult,
  type TentacleOptions,
  type TentacleRef,
} from './types.js';

/** Default cap on `tentacle()` calls per plan. Configurable via env. */
export const DEFAULT_MAX_TENTACLES = 200;

export function resolveMaxTentacles(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ZELARI_KRAKEN_MAX_TENTACLES;
  if (raw === undefined || raw === '') return DEFAULT_MAX_TENTACLES;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_TENTACLES;
}

/** Default wall-clock cap (ms) for the whole plan. */
export const DEFAULT_PLAN_TIMEOUT_MS = 30 * 60_000;

export function resolvePlanTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ZELARI_KRAKEN_PLAN_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_PLAN_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PLAN_TIMEOUT_MS;
}

/** Truncate text safely. Mirrors the verdict helper so we don't ship two
 *  implementations. */
function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated]`;
}

/** Build a TentacleRef from a host result + the options that produced it. */
function buildRef(
  id: string,
  opts: TentacleOptions,
  result: { ok: boolean; result?: string; error?: string; durationMs?: number; worktree?: string | null },
): TentacleRef {
  const findings = cap(
    result.ok ? (result.result ?? '').trim() : (result.error ?? 'unknown error'),
    MAX_FINDINGS_CHARS,
  );
  const ref: TentacleRef = {
    id,
    kind: opts.kind,
    label: opts.label,
    status: result.ok ? 'done' : 'error',
    findings,
    scope: opts.scope,
    ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    ...(result.worktree !== undefined ? { worktree: result.worktree } : {}),
  };
  // Parse a verdict trailer for any reviewer kind. The persona system
  // (Pillar 2) handles `verify`, `spec`, `conformance`; the default
  // parser extracts both the trailer and the per-requirement table.
  if (isReviewerKind(opts.kind)) {
    ref.verdict = defaultPersonaParse(findings).verdict;
  }
  return ref;
}

export interface ScriptRunnerOptions {
  /** Host bridge: this is the connection to the existing taskTool / worktree
   *  machinery. Wired by the CLI side. */
  host: PlanHostBridge;
  /** Original goal text (recorded in the snapshot). */
  goal: string;
  /** Stable id for this run. */
  graphId: string;
  /** Parent working directory. */
  parentCwd: string;
  /** Session id for radio correlation. */
  sessionId: string;
  /** Max tentacle calls allowed in this plan. */
  maxTentacles?: number;
  /** Wall-clock cap (ms) for the whole plan. */
  planTimeoutMs?: number;
}

/**
 * A `ScriptRunner` is constructed once per script plan, then drives the
 * script by exposing its `sdk` to the sandbox and bookkeeping the tentacles.
 */
export class ScriptRunner {
  private readonly host: PlanHostBridge;
  private readonly goal: string;
  private readonly graphId: string;
  private readonly parentCwd: string;
  private readonly sessionId: string;
  private readonly maxTentacles: number;
  private readonly planTimeoutMs: number;
  private readonly startTime: number;

  private readonly tentaclesById = new Map<string, TentacleRef>();
  private tentacleCount = 0;
  private mergeCount = 0;
  private cancelled = false;

  constructor(opts: ScriptRunnerOptions) {
    this.host = opts.host;
    this.goal = opts.goal;
    this.graphId = opts.graphId;
    this.parentCwd = opts.parentCwd;
    this.sessionId = opts.sessionId;
    this.maxTentacles = opts.maxTentacles ?? resolveMaxTentacles();
    this.planTimeoutMs = opts.planTimeoutMs ?? resolvePlanTimeoutMs();
    this.startTime = Date.now();
  }

  /** Build the `PlanCapabilities` object the sandbox will see. */
  buildSdk(): PlanCapabilities {
    return {
      tentacle: <T>(opts: TentacleOptions<T>): Promise<TentacleRef<T>> =>
        this.callTentacle(opts),
      barrier: <T extends readonly TentacleRef[]>(refs: T) =>
        this.callBarrier(refs) as Promise<{ -readonly [K in keyof T]: T[K] }>,
      race: <T extends readonly TentacleRef[]>(refs: T) =>
        this.callRace(refs) as Promise<T[number]>,
      while_: <T>(cond: () => boolean | Promise<boolean>, body: () => Promise<T>, maxIter: number) =>
        this.callWhile(cond, body, maxIter),
      until: <T>(cond: () => boolean | Promise<boolean>, body: () => Promise<T>, maxIter: number) =>
        this.callUntil(cond, body, maxIter),
      merge: (refs, opts) => this.callMerge(refs, opts),
      checkpoint: (label) => this.callCheckpoint(label),
      log: (msg, data) => this.callLog(msg, data),
      emit: (payload) => this.callEmit(payload),
      getContext: () => this.callGetContext(),
      sendTo: (peerId, payload) => this.callSendTo(peerId, payload),
    };
  }

  /** One tentacle = one `runTentacle` call. The host returns a raw result;
   *  we turn it into a `TentacleRef` and stash it. */
  private async callTentacle<T>(opts: TentacleOptions<T>): Promise<TentacleRef<T>> {
    if (this.cancelled) throw new PlanError('cancelled', 'runner is cancelled');
    if (this.tentacleCount >= this.maxTentacles) {
      throw new PlanError(
        'budget_exceeded',
        `tentacle cap (${this.maxTentacles}) reached; raise ZELARI_KRAKEN_MAX_TENTACLES`,
      );
    }
    if (this.tentacleCount > 0 && Date.now() - this.startTime > this.planTimeoutMs) {
      throw new PlanError(
        'budget_exceeded',
        `plan wall-clock budget (${this.planTimeoutMs}ms) exceeded`,
      );
    }
    this.tentacleCount += 1;

    // Build a stable id. We deliberately do NOT let the script pick ids
    // (collision risk); we synthesize one from a monotonic counter.
    const id = `t${String(this.tentacleCount).padStart(4, '0')}`;

    const res = await this.host.runTentacle({
      node: opts,
      parentCwd: this.parentCwd,
      sessionId: this.sessionId,
    });
    const ref = buildRef(id, opts, res);
    this.tentaclesById.set(id, ref);
    return ref as TentacleRef<T>;
  }

  private async callBarrier<T extends readonly TentacleRef[]>(
    refs: T,
  ): Promise<T> {
    // All refs are already resolved (tentacle() awaits). The barrier is a
    // *type* helper that lets the script treat parallel `tentacle()` calls
    // as a single awaitable tuple. It still costs one cap entry per ref —
    // the script MUST have called `tentacle()` for each.
    if (refs.some((r) => !this.tentaclesById.has(r.id))) {
      throw new PlanError('runtime_error', 'barrier() received a ref not in this runner');
    }
    return refs;
  }

  private async callRace<T extends readonly TentacleRef[]>(refs: T): Promise<T[number]> {
    if (refs.length === 0) {
      throw new PlanError('runtime_error', 'race() requires at least one ref');
    }
    // Tentacles are already resolved at the moment race() is called, so
    // "first to complete" is moot — we return the ref whose `durationMs`
    // is smallest (ties broken by id order for determinism). The script
    // can re-spawn losers if it needs actual racing in real time.
    let winner: TentacleRef = refs[0];
    for (const r of refs) {
      const a = winner.durationMs ?? Number.POSITIVE_INFINITY;
      const b = r.durationMs ?? Number.POSITIVE_INFINITY;
      if (b < a || (b === a && r.id < winner.id)) winner = r;
    }
    return winner as T[number];
  }

  private async callWhile<T>(
    cond: () => boolean | Promise<boolean>,
    body: () => Promise<T>,
    maxIter: number,
  ): Promise<T[]> {
    if (maxIter < 1) throw new PlanError('runtime_error', 'while_() maxIter must be ≥ 1');
    const out: T[] = [];
    let iter = 0;
    while (await cond()) {
      if (iter >= maxIter) {
        throw new PlanError(
          'budget_exceeded',
          `while_() exceeded maxIter=${maxIter} without cond turning false`,
        );
      }
      out.push(await body());
      iter += 1;
    }
    return out;
  }

  private async callUntil<T>(
    cond: () => boolean | Promise<boolean>,
    body: () => Promise<T>,
    maxIter: number,
  ): Promise<T[]> {
    return this.callWhile(async () => !(await cond()), body, maxIter);
  }

  /** One merge per plan. A second call is a structured error. */
  private async callMerge(
    refs: readonly TentacleRef[],
    opts: { strategy?: 'squash' | 'squash-sequential' | 'rebase' | 'manual'; message?: string; cleanup?: boolean } = {},
  ): ReturnType<PlanCapabilities['merge']> {
    if (this.mergeCount > 0) {
      throw new PlanError(
        'merge_already_done',
        'merge() called more than once; a plan can merge at most one batch',
      );
    }
    if (refs.length === 0) {
      throw new PlanError('runtime_error', 'merge() requires at least one ref');
    }
    for (const r of refs) {
      if (!this.tentaclesById.has(r.id)) {
        throw new PlanError('runtime_error', `merge() received unknown ref "${r.id}"`);
      }
    }
    this.mergeCount += 1;
    return this.host.mergeWorktrees({
      refs,
      parentCwd: this.parentCwd,
      strategy: opts.strategy ?? 'squash-sequential',
      ...(opts.message ? { message: opts.message } : {}),
      ...(opts.cleanup !== undefined ? { cleanup: opts.cleanup } : {}),
    });
  }

  private async callCheckpoint(label?: string): Promise<PlanSnapshot> {
    const snapshot: PlanSnapshot = {
      graphId: this.graphId,
      goal: this.goal,
      takenAt: new Date().toISOString(),
      completed: [...this.tentaclesById.values()].filter((r) => r.status === 'done'),
      inFlight: [...this.tentaclesById.values()].filter((r) => r.status === 'running'),
      failed: [...this.tentaclesById.values()].filter((r) => r.status === 'error'),
      pending: [],
    };
    const path = await this.host.saveSnapshot(snapshot, '.zelari/kraken/snapshots');
    this.host.log(`checkpoint: ${label ?? 'auto'} → ${path}`);
    return snapshot;
  }

  private callLog(msg: string, data?: Record<string, unknown>): void {
    const line = data ? `${msg} ${JSON.stringify(data)}` : msg;
    this.host.log(line);
  }

  private callEmit(payload: { kind: string; detail?: string; data?: Record<string, unknown> }): void {
    this.host.log(`emit: ${payload.kind}${payload.detail ? ` — ${payload.detail}` : ''}`);
  }

  private callGetContext(): PlanContext {
    return {
      graphId: this.graphId,
      goal: this.goal,
      parentCwd: this.parentCwd,
      sessionId: this.sessionId,
      tentacles: this.tentaclesById,
      maxTentacles: this.maxTentacles,
      planTimeoutMs: this.planTimeoutMs,
    };
  }

  private callSendTo(peerId: string, payload: { kind: string; detail?: string; data?: Record<string, unknown> }): void {
    this.host.log(`sendTo(${peerId}): ${payload.kind}${payload.detail ? ` — ${payload.detail}` : ''}`);
  }

  /** Called by the host after the sandbox returns, to mark the run. */
  finalize(opts: { converged: boolean; cancelled?: boolean }): ScriptRunResult {
    if (opts.cancelled) this.cancelled = true;
    const failed = [...this.tentaclesById.values()].filter((r) => r.status === 'error');
    return {
      tentacles: this.tentaclesById,
      mergeCount: this.mergeCount,
      converged: opts.converged,
      cancelled: this.cancelled,
      durationMs: Date.now() - this.startTime,
      unresolvedFindings: failed.map((r) => ({
        nodeId: r.id,
        label: r.label,
        reason: r.status === 'error' ? 'fail' : 'unknown',
        findings: r.findings,
      })),
    };
  }
}
