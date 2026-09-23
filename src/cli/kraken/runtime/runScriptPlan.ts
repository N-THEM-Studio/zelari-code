/**
 * Kraken script runtime — orchestration (CLI side).
 *
 * Ties together the three layers:
 *   1. `compileScriptPlan` (esbuild) — turns `plan.ts` into a runnable bundle.
 *   2. `ScriptRunner` (core) — owns the tentacle/merge/checkpoint budget.
 *   3. `runInSandbox` (core) — runs the bundle in a vm context.
 *
 * The host bridge here wires the script's `tentacle()` to the existing
 * `runTentacle` machinery in `taskTool.ts` and the script's `merge()` to
 * the existing `mergeKrakenWorktree`. We deliberately do NOT route
 * through the JSON-DAG `KrakenGraphExecutor` — the script is its own
 * execution shape, and the JSON executor doesn't have a way to express
 * loops, barriers, or `while_(cond, body)`.
 *
 * @since Kraken v1.30.x — workflow script runtime (F1.3)
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  ScriptRunner,
  runInSandbox,
  PlanError,
  type PlanHostBridge,
  type ScriptRunResult,
  type TentacleOptions,
  type TentacleRef,
  type MergeResult,
  type MergeStrategy,
} from '@zelari/core';
import { runTentacle, type TaskToolDeps, type TentacleResult } from '../../tools/taskTool.js';
import { mergeKrakenWorktree, type WorktreeHandle, type WorktreeMergeResult } from '../../tools/krakenWorktree.js';
import { resolvePersonaModel } from '../../tools/krakenModel.js';
import { compileScriptPlan } from './compile.js';
import { getPersona, type Persona } from '@zelari/core';
import { withParentModelDeps } from '../qualityEscalationHost.js';
// NOTE (K4.5b): the `spec`/`conformance` persona registration (Pillar 2) used
// to ride a side-effect `import '@zelari/core/kraken/personas'`. That subpath
// is absent from the package's `exports` map (it only resolves inside the
// bundled CLI); the root `@zelari/core` import above already re-exports
// `kraken/personas/index.js`, which registers both personas at load. Same
// side effect, resolvable from raw Node / vitest too.

export interface RunScriptPlanOptions {
  /** Path to the user's `.ts` plan file. */
  planPath: string;
  /** The original goal text (recorded in the snapshot). */
  goal: string;
  /** Stable id for this run (defaults to a timestamp). */
  graphId?: string;
  /** Parent working directory (the repo root). */
  parentCwd: string;
  /** Session id for radio correlation. */
  sessionId: string;
  /** Dependency bundle for `runTentacle` (the `taskToolDeps`). */
  taskToolDeps: TaskToolDeps;
  /** Optional abort signal — Ctrl-C settles the plan. */
  signal?: AbortSignal;
  /** Optional hook for log lines (e.g. the radio appender). */
  onLog?: (line: string) => void;
}

export interface RunScriptPlanOutcome {
  result: ScriptRunResult;
  /** Where the bundle was written (for the workbench / digest). */
  bundlePath: string;
  /** Bundle size in bytes. */
  bundleBytes: number;
}

/**
 * Compile + run a script plan end-to-end. Returns a structured result the
 * caller (the JSON executor, the slash handler, the headless mode) can
 * fold into a `KrakenExecutionSummary`.
 */
export async function runScriptPlan(opts: RunScriptPlanOptions): Promise<RunScriptPlanOutcome> {
  const graphId = opts.graphId ?? `kraken-script-${Date.now().toString(36)}`;
  const runDir = path.join(opts.parentCwd, '.zelari', 'kraken', 'runs', graphId);
  const bundlePath = path.join(runDir, 'plan.bundle.mjs');

  // 1. Compile.
  const compiled = await compileScriptPlan({ planPath: opts.planPath, outPath: bundlePath });
  opts.onLog?.(`compiled plan → ${bundlePath} (${compiled.bytes} bytes, ${compiled.durationMs}ms)`);

  // 2. Read the bundle.
  const bundleCode = await fs.readFile(bundlePath, 'utf8');

  // 3. Build the host bridge.
  // Side map: tentacle id (as the runner assigns it: `t0001`, `t0002`, …) →
  // its worktree handle (or null). Populated by runTentacle calls;
  // consumed by mergeWorktrees. Lives in the closure, not in the script's
  // namespace, so the script can't see it.
  const worktreeByTentacleId = new Map<string, WorktreeHandle | null>();
  // K4.5b (F27): key the map on the WORK UNIT, not on the raw call count. A
  // quality re-run (a call carrying `escalation`) is the SECOND call of the
  // same unit and must reuse that unit's id — a plain incremental counter
  // goes one ahead per re-run and every later worktree lands under the wrong
  // tentacle id. The bridge seam does not carry the runner's id (it predates
  // the hint), so we mirror its monotonic `t%04d` scheme and anchor each id
  // to the unit's `node` identity: the escalation wrapper re-sends the SAME
  // node object for both calls of one unit.
  const idByNode = new WeakMap<TentacleOptions, string>();
  let nextTentacleId = 1;

  const host: PlanHostBridge = {
    runTentacle: async (args) => {
      // Resolve a persona system prompt for reviewer kinds (Pillar 2).
      // Importing the persona module triggers the side-effect registration
      // of `spec` and `conformance`, so we always look up by kind.
      const persona = getPersonaForKind(args.node.kind);
      // K4.5 (F27): a quality re-run (`escalation.to === 'parent-model'`) must
      // NOT honor `node.model`/sub-model routing — it starts on the PARENT/lead
      // model. The lead identity rides `SubAgentContext.fallback`, forced by
      // `withParentModelDeps` for this call only. No hint ⇒ identical routing
      // to before (same deps object, untouched).
      const deps =
        args.escalation?.to === 'parent-model'
          ? withParentModelDeps(opts.taskToolDeps)
          : opts.taskToolDeps;
      const res = await runTentacle({
        deps,
        args: {
          description: args.node.label,
          prompt: args.node.prompt,
          ...(args.node.scope ? { scope: args.node.scope } : {}),
          ...(args.node.acceptance ? { acceptance: args.node.acceptance } : {}),
        },
        agent: agentKindFor(args.node.kind),
        thoroughness: args.node.thoroughness ?? 'medium',
        parentCwd: args.parentCwd,
        sessionId: args.sessionId,
        ...(opts.signal ? { signal: opts.signal } : {}),
        // We always want the script to control merges explicitly, so the
        // `task` tool's auto-merge is off; we drive it from `merge()`.
        deferMerge: true,
        ...(persona ? { systemPromptOverride: persona.systemPrompt } : {}),
      });
      // K4.5b: real-id keying. A non-escalation call opens a NEW work unit and
      // takes the next id in the runner's sequence; an escalation re-run reuses
      // the id of the unit it re-runs (same `node` object), so the map holds
      // exactly one entry per tentacle id no matter how many re-runs fire.
      const priorId = idByNode.get(args.node);
      const isRerun = args.escalation !== undefined;
      const tentacleId =
        isRerun && priorId !== undefined
          ? priorId
          : `t${String(nextTentacleId).padStart(4, '0')}`;
      if (!isRerun || priorId === undefined) nextTentacleId += 1;
      idByNode.set(args.node, tentacleId);
      if (res.ok) {
        // On a re-run this OVERWRITES the entry with the winning (re-run)
        // worktree — the one whose output replaced the weak one and the one
        // `ref.worktree` will point at. The superseded handle is dropped from
        // the map and its worktree stays on disk, surfaced by the escalation
        // event on the radio (kept, never destroyed).
        worktreeByTentacleId.set(tentacleId, res.worktreeHandle);
        return {
          ok: true,
          result: res.result,
          durationMs: undefined,
          worktree: res.worktreePath,
        };
      }
      // A FAILED quality re-run keeps the original output (core contract), so
      // its worktree entry must survive untouched. A failed first attempt
      // records no worktree, exactly as before.
      if (!isRerun) {
        worktreeByTentacleId.set(tentacleId, null);
      }
      return { ok: false, error: res.error, durationMs: undefined, worktree: null };
    },
    mergeWorktrees: async (args) => {
      return runScriptMerge({
        refs: args.refs,
        parentCwd: args.parentCwd,
        strategy: args.strategy,
        message: args.message,
        cleanup: args.cleanup,
        worktreeByTentacleId,
        onLog: opts.onLog,
      });
    },
    log: (line) => opts.onLog?.(line),
    saveSnapshot: async (snapshot, dir) => {
      const dirAbs = path.isAbsolute(dir) ? dir : path.join(opts.parentCwd, dir);
      await fs.mkdir(dirAbs, { recursive: true });
      const file = path.join(dirAbs, `${snapshot.graphId}-${snapshot.takenAt.replace(/[:.]/g, '-')}.json`);
      await fs.writeFile(file, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
      return file;
    },
    signal: () => opts.signal,
  };

  // 4. Build the runner and run.
  const runner = new ScriptRunner({
    host,
    goal: opts.goal,
    graphId,
    parentCwd: opts.parentCwd,
    sessionId: opts.sessionId,
  });

  try {
    await runInSandbox({
      bundleCode,
      sdk: runner.buildSdk() as unknown as Record<string, unknown>,
      timeoutMs: 30 * 60_000,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    // A runtime error: settle the result and re-raise so the caller knows.
    const partial = runner.finalize({ converged: false, cancelled: err instanceof PlanError && err.kind === 'cancelled' });
    opts.onLog?.(
      `plan failed: ${err instanceof Error ? err.message : String(err)} ` +
        `(merged=${partial.mergeCount > 0}, tentacles=${partial.tentacles.size})`,
    );
    return { result: partial, bundlePath, bundleBytes: compiled.bytes };
  }

  const result = runner.finalize({ converged: true });
  opts.onLog?.(
    `plan converged in ${result.durationMs}ms ` +
      `(tentacles=${result.tentacles.size}, merged=${result.mergeCount > 0})`,
  );
  return { result, bundlePath, bundleBytes: compiled.bytes };
}

/** Map a script's kind onto the existing `TaskAgentKind`. `spec` and
 *  `conformance` (Pillar 2) collapse to 'verify' — the persona is
 *  enforced at the prompt level (via the system prompt override), not
 *  the host agent level. */
function agentKindFor(kind: TentacleOptions['kind']): 'explore' | 'general' | 'verify' {
  if (kind === 'explore') return 'explore';
  if (kind === 'verify' || kind === 'spec' || kind === 'conformance') return 'verify';
  return 'general';
}

/** Look up a registered persona by script kind. Returns undefined for
 *  non-reviewer kinds (explore, general, fix, merge) so the host
 *  doesn't get a system prompt override. */
function getPersonaForKind(kind: TentacleOptions['kind']): Persona | undefined {
  return getPersona(kind);
}

interface RunScriptMergeArgs {
  refs: readonly TentacleRef[];
  parentCwd: string;
  strategy: MergeStrategy;
  message?: string;
  cleanup?: boolean;
  worktreeByTentacleId: Map<string, WorktreeHandle | null>;
  onLog?: (line: string) => void;
}

async function runScriptMerge(args: RunScriptMergeArgs): Promise<MergeResult> {
  const merged: string[] = [];
  const conflicts: { nodeId: string; reason: string }[] = [];
  const cleanup = args.cleanup ?? true;

  for (const ref of args.refs) {
    // Verify tentacles have no worktree of their own. (`spec` and
    // `conformance` will be added in Pillar 2.)
    if (ref.kind === 'verify') {
      continue;
    }
    const handle = args.worktreeByTentacleId.get(ref.id);
    if (!handle) {
      // Either the script asked to merge a tentacle the host didn't actually
      // run (race condition?) or the worktree is gone. Surface as a soft
      // skip, not a hard error — the writer's work may have already been
      // merged by a previous call.
      args.onLog?.(`merge: no worktree for ${ref.id} (${ref.label}); skipping`);
      continue;
    }
    const result: WorktreeMergeResult = await mergeKrakenWorktree(
      handle,
      {
        ...(args.message ? { message: args.message } : {}),
        cleanup,
      },
    );
    if (result.ok && result.merged) {
      merged.push(ref.id);
    } else if (result.conflict) {
      conflicts.push({ nodeId: ref.id, reason: 'git conflict' });
    } else {
      conflicts.push({ nodeId: ref.id, reason: result.message || 'merge failed' });
    }
  }

  return { merged, conflicts, ok: conflicts.length === 0 };
}
