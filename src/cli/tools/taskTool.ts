/**
 * taskTool — delegate a bounded sub-task to an isolated sub-agent (Kraken tentacle).
 *
 * Isolation & safety:
 *   - explore / verify: READ-ONLY (or read+bash for verify)
 *   - general: full tools except nested `task` (no recursion)
 *   - Parent gets only a short conclusion, not the full sub-transcript
 *   - Optional git worktree for general when ZELARI_KRAKEN_WORKTREE=1
 *   - Radio JSONL under .zelari/radio/ for parent observability
 *
 * Structure (F2 — Kraken graph engine):
 *   - `runTentacle()` is the standalone, exported core run (worktree + radio +
 *     live + harness + merge + footer). It has NO spawn-cap so the graph
 *     executor can drive many tentacles directly.
 *   - The `task` tool's `execute` is a thin wrapper that applies the per-turn
 *     spawn cap and maps the TentacleResult back to typedOk/typedErr.
 *
 * @since v0.7.x · typed agents v1.21.0 · Kraken contracts v1.x · graph F2
 */

import { z } from 'zod';
import type {
  AgentToolSpec,
  ProviderStreamFn,
  AgentHarnessConfig,
} from '@zelari/core/harness';
import type { BrainEvent } from '@zelari/core/shared/events';
import type { ToolRegistry } from '@zelari/core/harness/tools/registry';
import {
  typedOk,
  typedErr,
  type ToolDefinition,
  type TypedResult,
} from '@zelari/core/harness/tools/toolTypes';
import { appendKrakenRadio } from './krakenRadio.js';
import {
  createKrakenWorktree,
  cleanupKrakenWorktree,
  formatWorktreeFooter,
  isKrakenWorktreeEnabled,
  shouldKeepWorktree,
  mergeKrakenWorktree,
  isKrakenWorktreeAutoMergeEnabled,
  type WorktreeHandle,
  type WorktreeMergeResult,
} from './krakenWorktree.js';
import { krakenTentacleStart, krakenTentacleEnd } from './krakenLive.js';

/** Sub-agent kinds (OpenCode-inspired). */
export type TaskAgentKind = 'explore' | 'general' | 'verify';
export type TaskThoroughness = 'quick' | 'medium' | 'deep';

/** Everything a sub-agent needs to run, built fresh per invocation. */
export interface SubAgentContext {
  providerStream: ProviderStreamFn;
  model: string;
  provider: string;
  registry: ToolRegistry;
  tools: AgentToolSpec[];
  /** Effective agent kind for prompts / budgets. */
  agent?: TaskAgentKind;
  /**
   * Optional cwd override (e.g. git worktree path). When set, harness + tools
   * run with this as working directory / sandbox root.
   */
  cwd?: string;
}

/** A minimal harness surface — just the event stream. */
export interface SubAgentHarness {
  run(): AsyncIterable<BrainEvent>;
}

export interface TaskToolDeps {
  /**
   * Build provider + tool registry for one sub-agent run.
   * `agent` selects tool set (explore RO / general write / verify tests).
   * `cwd` is the effective working directory (parent cwd or worktree).
   */
  createSubAgentContext: (opts: {
    agent: TaskAgentKind;
    thoroughness: TaskThoroughness;
    cwd: string;
  }) => Promise<SubAgentContext | null>;
  /** Construct the harness. Overridable in tests; defaults to AgentHarness. */
  harnessFactory?: (config: AgentHarnessConfig) => SubAgentHarness;
  /**
   * When true (default), general tentacles may use a git worktree if
   * ZELARI_KRAKEN_WORKTREE=1. Tests can force-disable.
   */
  allowWorktree?: boolean;
}

const EXPLORE_PROMPT = [
  'You are a focused EXPLORE tentacle of Kraken (parent super-agent).',
  'READ-ONLY tools only (read, list, grep, fetch). No edits, no shell.',
  'OBSERVATION INTEGRITY: negative evidence is valid only from a completed',
  'observation. Never conclude that code/symbols/files do not exist from',
  'degraded results, zero files examined, or unavailable backends - report',
  'the degraded status instead and widen the observation.',
  'Gather only what you need, then STOP with a concise conclusion:',
  'file paths, symbols, line refs, and how things connect. No large dumps.',
  'Respect any Scope / Acceptance sections in the user prompt.',
  'Do not ask follow-up questions.',
].join('\n');

const GENERAL_PROMPT = [
  'You are a GENERAL tentacle of Kraken that can read AND modify the codebase',
  'for one bounded unit of work. Prefer small, correct edits.',
  'Stay inside Scope paths if provided. Match existing style. No drive-by refactors.',
  'Run light checks when needed. Return: what changed, files touched, risks.',
  'Do not spawn further sub-agents. Do not expand scope beyond the prompt.',
  'If you are in a git worktree, edit only inside this working tree.',
].join('\n');

const VERIFY_PROMPT = [
  'You are a VERIFY tentacle of Kraken. Confirm whether work is correct on disk.',
  'You may read files and run test/build commands via bash. Prefer',
  'targeted checks over full suite when possible.',
  'Report: pass/fail, commands run, key output, and gaps vs Acceptance criteria.',
  'If Acceptance criteria are listed, check each one explicitly.',
].join('\n');

type SpawnGlobal = {
  __zelariTaskSpawnCount?: number;
  __zelariLastGeneralAt?: number;
};

/** Reset spawn counter (call at start of each parent user turn). */
export function resetTaskSpawnCount(): void {
  const g = globalThis as unknown as SpawnGlobal;
  g.__zelariTaskSpawnCount = 0;
}

/** Max concurrent/serial task spawns per parent turn (env override). */
export function maxTaskSpawnsPerTurn(): number {
  const raw = process.env.ZELARI_KRAKEN_MAX_TASK_SPAWNS;
  if (raw === undefined || raw === '') return 6;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 32) : 6;
}

/**
 * After a successful general tentacle that changed code, remind the parent
 * to verify (K4 soft gate — prompt-level + result footer).
 */
export function verifyHintForGeneral(acceptance?: string[]): string {
  const acc =
    acceptance && acceptance.length > 0
      ? ` Acceptance to check: ${acceptance.join('; ')}.`
      : '';
  return (
    `[kraken:verify-hint] General tentacle finished. Before claiming done, ` +
    `run checks or spawn task agent=verify.${acc}`
  );
}

/** Build user message with optional contract fields (Fractal-style NODE contract). */
export function buildTaskUserPrompt(args: {
  prompt: string;
  scope?: string[];
  acceptance?: string[];
}): string {
  const parts: string[] = [args.prompt.trim()];
  if (args.scope && args.scope.length > 0) {
    parts.push(
      '',
      '## Scope (path allowlist — do not edit outside)',
      ...args.scope.map((s) => `- ${s}`),
    );
  }
  if (args.acceptance && args.acceptance.length > 0) {
    parts.push('', '## Acceptance criteria', ...args.acceptance.map((a) => `- ${a}`));
  }
  return parts.join('\n');
}

export function systemPromptForAgent(agent: TaskAgentKind): string {
  if (agent === 'general') return GENERAL_PROMPT;
  if (agent === 'verify') return VERIFY_PROMPT;
  return EXPLORE_PROMPT;
}

export function maxToolCallsForThoroughness(
  thoroughness: TaskThoroughness,
  agent: TaskAgentKind,
): number {
  if (agent === 'general') {
    if (thoroughness === 'quick') return 8;
    if (thoroughness === 'deep') return 20;
    return 12;
  }
  if (agent === 'verify') {
    if (thoroughness === 'quick') return 6;
    if (thoroughness === 'deep') return 14;
    return 10;
  }
  // explore
  if (thoroughness === 'quick') return 4;
  if (thoroughness === 'deep') return 12;
  return 6;
}

/** @deprecated use systemPromptForAgent('explore') — kept for tests */
export const SUBAGENT_SYSTEM_PROMPT = EXPLORE_PROMPT;

const TaskArgsSchema = z.object({
  description: z
    .string()
    .min(1)
    .describe('A 3-6 word label for the sub-task (for logs/UI).'),
  prompt: z
    .string()
    .min(1)
    .describe(
      'The full, self-contained instruction for the sub-agent. It has no access ' +
        'to this conversation, so include all context it needs. Prefer Goal/Scope/Acceptance.',
    ),
  agent: z
    .enum(['explore', 'general', 'verify'])
    .optional()
    .describe(
      'Sub-agent type: explore (read-only research, default), general (can edit), ' +
        'verify (read + bash tests). Prefer explore for search; general for isolated edits.',
    ),
  thoroughness: z
    .enum(['quick', 'medium', 'deep'])
    .optional()
    .describe('How deep the sub-agent should go (tool budget). Default medium.'),
  scope: z
    .array(z.string().min(1))
    .max(32)
    .optional()
    .describe(
      'Optional path/glob allowlist for this tentacle (contract). Appended to the prompt as Scope.',
    ),
  acceptance: z
    .array(z.string().min(1))
    .max(16)
    .optional()
    .describe(
      'Optional acceptance checklist (contract). Appended to the prompt as Acceptance criteria.',
    ),
});

type TaskArgs = z.infer<typeof TaskArgsSchema>;

/**
 * Run a sub-agent to completion and return the text of its final assistant
 * message (the "conclusion"). Intermediate tool-call turns are discarded.
 *
 * When `signal` aborts, the `for await` loop breaks, which calls `.return()`
 * on the `AgentHarness.run()` async generator and unwinds it — the sub-agent
 * stops before starting its next tool call, so it cannot keep writing files
 * after the caller has given up on it. Reports `aborted: true` so callers can
 * tell "the run stopped on request" from "the run finished on its own"; that
 * distinction matters to the graph executor, which must not re-spawn a node
 * onto a scope another tentacle may still be writing to.
 */
export async function runSubAgent(
  harness: SubAgentHarness,
  opts: { signal?: AbortSignal } = {},
): Promise<{ result: string; error?: string; aborted?: boolean }> {
  const { signal } = opts;
  let current = '';
  let lastCompleted = '';
  let error: string | undefined;
  if (signal?.aborted) return { result: '', aborted: true };
  for await (const ev of harness.run()) {
    if (signal?.aborted) {
      return {
        result: (lastCompleted || current).trim(),
        ...(error ? { error } : {}),
        aborted: true,
      };
    }
    switch (ev.type) {
      case 'message_start':
        current = '';
        break;
      case 'message_delta':
        current += ev.delta;
        break;
      case 'message_end':
        if (current.trim()) lastCompleted = current;
        current = '';
        break;
      case 'error':
        error = ev.message;
        break;
      default:
        break;
    }
  }
  const result = (lastCompleted || current).trim();
  return { result, ...(error ? { error } : {}) };
}

/** Successful tentacle run (raw conclusion + footer, no `[sub-agent:…]` prefix). */
export interface TentacleSuccess {
  ok: true;
  agent: TaskAgentKind;
  thoroughness: TaskThoroughness;
  /** Model actually used by the sub-agent. */
  model: string;
  /** Raw sub-agent conclusion (no prefix, no footer). */
  result: string;
  /** Worktree + verify-hint footer (leading newline included), or ''. */
  footer: string;
  /** Git worktree path if one was used, else null. */
  worktreePath: string | null;
  /**
   * Full worktree handle when one was created (regardless of deferMerge),
   * else null. The graph executor (F3) uses this to merge/cleanup explicitly
   * when `deferMerge` was requested.
   */
  worktreeHandle: WorktreeHandle | null;
}

/** Failed tentacle run. `error` is the exact message previously given to typedErr. */
export interface TentacleFailure {
  ok: false;
  agent: TaskAgentKind;
  error: string;
  /**
   * True when the run stopped because its `signal` aborted, i.e. the sub-agent
   * is confirmed to have unwound rather than still running somewhere. The
   * graph executor uses this to decide whether re-running the node onto the
   * same scope is safe.
   */
  cancelled?: boolean;
}

export type TentacleResult = TentacleSuccess | TentacleFailure;

/** Inputs for a single tentacle run (shared by the `task` tool and the graph executor). */
export interface RunTentacleOptions {
  deps: TaskToolDeps;
  args: {
    description: string;
    prompt: string;
    scope?: string[];
    acceptance?: string[];
  };
  agent: TaskAgentKind;
  thoroughness: TaskThoroughness;
  /** Parent working directory (worktrees are created relative to this). */
  parentCwd: string;
  /**
   * Run the sub-agent in this directory instead of `parentCwd`, without making
   * it the worktree/radio root. The graph executor uses it to run a `verify`
   * tentacle inside the worktree its writer produced: verification happens
   * before the merge node, so checking `parentCwd` meant checking a tree that
   * did not yet contain the work being verified. Ignored when this tentacle
   * creates a worktree of its own (writers).
   */
  cwdOverride?: string;
  /** Session id used for radio JSONL correlation. */
  sessionId: string;
  /**
   * When true and a worktree was created for this tentacle, skip the
   * auto-merge/cleanup step entirely and return the worktree handle so the
   * caller (graph executor) can merge multiple tentacles' branches
   * sequentially instead of racing concurrent merges into the same parent
   * HEAD. Ignored when no worktree is used. Default false (current `task`
   * tool behavior: merge immediately).
   */
  deferMerge?: boolean;
  /** Graph engine (F5): tag the live tentacle entry with its graph/node id. */
  graphId?: string;
  nodeId?: string;
  /**
   * Cancels the sub-agent run. The graph executor aborts this when a node
   * exceeds its wall-clock budget, so the tentacle stops instead of running on
   * (and writing) while the executor retries the same scope.
   */
  signal?: AbortSignal;
  /**
   * Override the system prompt. Used by Pillar 2 persona kinds
   * (`spec`, `conformance`) to inject the persona's specific prompt
   * even when the host agent is `verify`. When unset, falls back to
   * `systemPromptForAgent(agent)`.
   */
  systemPromptOverride?: string;
}

/**
 * Run one Kraken tentacle end-to-end: optional worktree isolation, radio +
 * live tracking, sub-agent harness run, worktree squash-merge, and footer
 * assembly. Returns a discriminated result instead of a TypedResult so callers
 * (the `task` tool wrapper, the graph executor) can react programmatically.
 *
 * Deliberately has NO spawn-cap: the per-turn cap is a `task`-tool policy
 * applied by the wrapper; the graph executor budgets concurrency itself.
 */
export async function runTentacle(opts: RunTentacleOptions): Promise<TentacleResult> {
  const { deps, args, agent, thoroughness, parentCwd, sessionId } = opts;
  const started = Date.now();
  const g = globalThis as unknown as SpawnGlobal;

  // Optional worktree isolation for general writers (K7).
  let worktree: WorktreeHandle | null = null;
  let effectiveCwd = opts.cwdOverride || parentCwd;
  const wantWt =
    agent === 'general' &&
    deps.allowWorktree !== false &&
    isKrakenWorktreeEnabled();
  if (wantWt) {
    try {
      worktree = await createKrakenWorktree(parentCwd, args.description);
      if (worktree) effectiveCwd = worktree.path;
    } catch {
      worktree = null;
    }
  }

  appendKrakenRadio(parentCwd, sessionId, {
    kind: 'spawn',
    agent,
    thoroughness,
    description: args.description,
    worktree: worktree?.path ?? null,
  });
  // G1 (K10): track the tentacle in-process so StatusBar / Desktop can show
  // "tentacles 1↑ 2✓" live during the parent turn.
  const liveId = krakenTentacleStart({
    agent,
    description: args.description,
    worktree: worktree?.path ?? null,
    ...(opts.graphId ? { graphId: opts.graphId } : {}),
    ...(opts.nodeId ? { nodeId: opts.nodeId } : {}),
  });

  let sub: SubAgentContext | null;
  try {
    sub = await deps.createSubAgentContext({
      agent,
      thoroughness,
      cwd: effectiveCwd,
    });
  } catch (err) {
    if (worktree) await cleanupKrakenWorktree(worktree);
    appendKrakenRadio(parentCwd, sessionId, {
      kind: 'error',
      agent,
      description: args.description,
      detail: err instanceof Error ? err.message : String(err),
      ok: false,
      durationMs: Date.now() - started,
    });
    krakenTentacleEnd(liveId, { ok: false, durationMs: Date.now() - started });
    return {
      ok: false,
      agent,
      error: `task: could not initialize sub-agent — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!sub) {
    if (worktree) await cleanupKrakenWorktree(worktree);
    appendKrakenRadio(parentCwd, sessionId, {
      kind: 'error',
      agent,
      description: args.description,
      detail: 'no provider',
      ok: false,
      durationMs: Date.now() - started,
    });
    krakenTentacleEnd(liveId, { ok: false, durationMs: Date.now() - started });
    return {
      ok: false,
      agent,
      error: 'task: no provider configured for the sub-agent (set an API key / run /login).',
    };
  }

  const userContent = buildTaskUserPrompt({
    prompt: args.prompt,
    scope: args.scope,
    acceptance: args.acceptance,
  });
  const maxToolCalls = maxToolCallsForThoroughness(thoroughness, agent);
  const runCwd = sub.cwd || effectiveCwd;
  const config: AgentHarnessConfig = {
    model: sub.model,
    provider: sub.provider,
    messages: [
      { role: 'system', content: opts.systemPromptOverride ?? systemPromptForAgent(agent) },
      { role: 'user', content: userContent },
    ],
    tools: sub.tools,
    toolRegistry: sub.registry,
    providerStream: sub.providerStream,
    cwd: runCwd,
    maxToolCallsPerTurn: maxToolCalls,
    maxToolLoopIterations: Math.max(12, maxToolCalls + 4),
  };

  let harness: SubAgentHarness;
  try {
    if (deps.harnessFactory) {
      harness = deps.harnessFactory(config);
    } else {
      const { AgentHarness } = await import('@zelari/core/harness');
      harness = new AgentHarness(config);
    }
  } catch (err) {
    if (worktree) await cleanupKrakenWorktree(worktree);
    krakenTentacleEnd(liveId, { ok: false, durationMs: Date.now() - started });
    return {
      ok: false,
      agent,
      error: `task: failed to start sub-agent — ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const { result, error, aborted } = await runSubAgent(harness, {
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const durationMs = Date.now() - started;

  if (aborted) {
    // Cancelled by the caller (node timeout). Leave a worktree in place only
    // if it would have been kept anyway — otherwise clean up, since no result
    // is coming and an orphan worktree would linger.
    if (worktree && !shouldKeepWorktree()) await cleanupKrakenWorktree(worktree);
    appendKrakenRadio(parentCwd, sessionId, {
      kind: 'error',
      agent,
      thoroughness,
      description: args.description,
      detail: 'cancelled: node timeout',
      model: sub.model,
      worktree: worktree?.path ?? null,
      durationMs,
      ok: false,
    });
    krakenTentacleEnd(liveId, {
      ok: false,
      model: sub.model,
      detail: 'cancelled',
      durationMs,
    });
    return { ok: false, agent, error: 'task: sub-agent cancelled (node timeout)', cancelled: true };
  }

  if (!result) {
    if (worktree) await cleanupKrakenWorktree(worktree);
    appendKrakenRadio(parentCwd, sessionId, {
      kind: 'error',
      agent,
      thoroughness,
      description: args.description,
      detail: error ?? 'no output',
      model: sub.model,
      worktree: worktree?.path ?? null,
      durationMs,
      ok: false,
    });
    krakenTentacleEnd(liveId, { ok: false, model: sub.model, detail: error, durationMs });
    return {
      ok: false,
      agent,
      error: `task: sub-agent (${agent}) produced no output${error ? ` (${error})` : ''}.`,
    };
  }

  const kept = worktree ? shouldKeepWorktree() : false;
  let footer = '';
  if (worktree && opts.deferMerge && !kept) {
    // Graph executor (F3) owns merge ordering — leave the worktree + branch
    // in place; the caller merges (sequentially, across tentacles) and
    // cleans up via the returned worktreeHandle.
    footer += `\nworktree deferred: branch=${worktree.branch} path=${worktree.path} (executor merges)`;
  } else if (worktree) {
    // G2: before cleanup, squash-merge the tentacle branch into the parent
    // HEAD so the sub-agent's edits survive. Without this the worktree is
    // removed and all edits are lost (the original gap).
    let merge: WorktreeMergeResult | null = null;
    if (!kept && isKrakenWorktreeAutoMergeEnabled()) {
      try {
        merge = await mergeKrakenWorktree(
          worktree,
          { message: `kraken: merge ${args.description.slice(0, 80)}` },
        );
      } catch (err) {
        merge = {
          ok: false,
          merged: false,
          committed: false,
          message: `merge threw: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } else if (!kept) {
      // auto-merge disabled — fall back to bare cleanup (old behavior)
      await cleanupKrakenWorktree(worktree);
    }
    footer += `\n${formatWorktreeFooter(worktree, { kept, merge })}`;
  }
  if (agent === 'general') {
    footer += `\n${verifyHintForGeneral(args.acceptance)}`;
    g.__zelariLastGeneralAt = Date.now();
  }

  krakenTentacleEnd(liveId, {
    ok: true,
    model: sub.model,
    detail: result.slice(0, 160),
    durationMs,
  });

  appendKrakenRadio(parentCwd, sessionId, {
    kind: agent === 'general' ? 'verify_hint' : 'done',
    agent,
    thoroughness,
    description: args.description,
    detail: result.slice(0, 240),
    model: sub.model,
    worktree: worktree?.path ?? null,
    durationMs,
    ok: true,
  });

  return {
    ok: true,
    agent,
    thoroughness,
    model: sub.model,
    result,
    footer,
    worktreePath: worktree?.path ?? null,
    worktreeHandle: worktree,
  };
}

/** Build the `task` tool from injected sub-agent deps. */
export function createTaskTool(
  deps: TaskToolDeps,
): ToolDefinition<TaskArgs, { result: string; agent: string }> {
  return {
    name: 'task',
    description:
      'Delegate a focused sub-task to an isolated sub-agent with its own context; ' +
      'returns only a concise conclusion (keeps parent context lean).\n' +
      '- agent=explore (default): read-only research/search\n' +
      '- agent=general: can edit files for one bounded unit of work\n' +
      '- agent=verify: read + bash to run tests/checks\n' +
      'Provide a fully self-contained `prompt` (sub-agent cannot see this conversation). ' +
      'Optional scope[] + acceptance[] contracts. After general, follow up with verify.',
    permissions: ['read', 'network', 'write', 'execute'],
    timeoutMs: 300_000,
    inputSchema: TaskArgsSchema,
    execute: async (args, ctx): Promise<TypedResult<{ result: string; agent: string }>> => {
      const agent: TaskAgentKind = args.agent ?? 'explore';
      const thoroughness: TaskThoroughness = args.thoroughness ?? 'medium';
      const sessionId = ctx.sessionId || 'default';
      const parentCwd = ctx.cwd || process.cwd();

      // Per-process spawn cap (Kraken K3). Reset via resetTaskSpawnCount() each parent turn.
      const g = globalThis as unknown as SpawnGlobal;
      g.__zelariTaskSpawnCount = (g.__zelariTaskSpawnCount ?? 0) + 1;
      const spawnCap = maxTaskSpawnsPerTurn();
      if (g.__zelariTaskSpawnCount > spawnCap) {
        return typedErr(
          `task: spawn cap reached (${spawnCap}). Finish the current slice or raise ZELARI_KRAKEN_MAX_TASK_SPAWNS.`,
        );
      }

      const res = await runTentacle({
        deps,
        args: {
          description: args.description,
          prompt: args.prompt,
          scope: args.scope,
          acceptance: args.acceptance,
        },
        agent,
        thoroughness,
        parentCwd,
        sessionId,
      });

      if (!res.ok) return typedErr(res.error);
      return typedOk({
        result: `[sub-agent:${res.agent}/${res.thoroughness} model=${res.model}]\n${res.result}${res.footer}`,
        agent: res.agent,
      });
    },
  };
}
