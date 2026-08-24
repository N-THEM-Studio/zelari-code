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
import type { UsageBreakdown } from '@zelari/core/events';
import type { MemoryService } from '@zelari/core/memory';
import {
  candidateInstructions,
  isKrakenSelectionEnabled,
  krakenRequiredChecks,
  parseCandidateReport,
  registerCandidate,
  reserveCandidateSlot,
  setKrakenCheckResults,
} from '../kraken/candidateRegistry.js';
import { allUnknownCheckResults, parseVerifyReport, type TentacleToolTrace } from '../kraken/verifyReport.js';
import { recordCandidateTokens } from '../kraken/metrics.js';

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
  /** Stop an in-flight run (provider stream + nested tools). */
  cancel?(): void;
}

/**
 * Wall-clock bound for the `task` tool wrapper (parent AgentHarness invoke).
 * Must cover a `general` writer: 5 minutes is not enough on a slow reasoning
 * model. Keep aligned with DEFAULT_WRITER_NODE_TIMEOUT_MS in kraken/executor.
 */
export const TASK_TOOL_TIMEOUT_MS = 900_000;

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
  /** Shared native project memory used by every tentacle in this run. */
  memoryService?: MemoryService;
  /** Persist concise tentacle outcomes. Defaults true when memoryService exists. */
  memoryAutoWrite?: boolean;
}

/**
 * Policy limiting which sub-agent kinds a `task` tool may spawn (Fase 1,
 * ADR-0020). Plan mode registers the tool with `allowedAgents: ['explore']`
 * so PLAN can parallelize research without ever gaining write/execute
 * tentacles; BUILD keeps the unrestricted default.
 */
export interface TaskToolPolicy {
  /** Allowed sub-agent kinds. Default: explore + general + verify. */
  allowedAgents?: readonly TaskAgentKind[];
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
  'End your final message with ONE <verify-report> block per acceptance',
  'criterion (required checks included), in this exact shape:',
  '<verify-report>',
  'check: <criterion text as given>',
  'status: pass | fail | unknown',
  'note: <one line of evidence (command + outcome)>',
  '</verify-report>',
  'Use status=unknown when you could NOT determine the outcome (degraded',
  'tool, timeout, inconclusive evidence) — never guess pass.',
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

/**
 * Fase 6 (ADR-0020): BUILD dynamic checks. When kraken_select selected a
 * candidate this turn, its requiredChecks become proof obligations of
 * every verify tentacle — appended to the parent's acceptance (deduped,
 * case-insensitive) or the whole acceptance when the parent provided
 * none. Explore/general are never touched; verify is PLAN-rejected
 * (Fase 1), so this path is BUILD-only by construction. No flag gate
 * needed: a verdict can only exist when the selection tool ran.
 */
export function withKrakenRequiredChecks(
  agent: TaskAgentKind,
  acceptance?: string[],
): string[] | undefined {
  if (agent !== 'verify') return acceptance;
  const required = krakenRequiredChecks();
  if (required.length === 0) return acceptance;
  const seen = new Set((acceptance ?? []).map((a) => a.trim().toLowerCase()));
  const merged = [...(acceptance ?? [])];
  for (const check of required) {
    const key = check.trim().toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(check);
    }
  }
  return merged;
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

const TaskPurposeSchema = z
  .enum(['candidate'])
  .optional()
  .describe(
    'Mark this explore tentacle as one CANDIDATE hypothesis (alpha: requires ' +
      'ZELARI_KRAKEN_SELECTION=1). Forces agent=explore, structured report.',
  );

const TaskArgsWithPurposeSchema = TaskArgsSchema.extend({
  purpose: TaskPurposeSchema,
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
/** Bounded tentacle tool trace (2.1 T5): ring size + output excerpt cap. */
const TOOL_TRACE_RING = 24;
const TOOL_TRACE_OUTPUT_MAX = 600;

/** Best-effort command/path hint from tool args, for note→tool matching. */
function toolCommandHint(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  for (const key of ['command', 'cmd', 'script', 'pattern', 'path', 'query', 'url']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 160);
  }
  return undefined;
}

export async function runSubAgent(
  harness: SubAgentHarness,
  opts: { signal?: AbortSignal } = {},
): Promise<{ result: string; error?: string; aborted?: boolean; usage?: UsageBreakdown; toolTrace?: TentacleToolTrace[] }> {
  const { signal } = opts;
  let current = '';
  let lastCompleted = '';
  let error: string | undefined;
  let usage: UsageBreakdown | undefined;
  /** toolCallId → { tool, command } captured at tool_execution_start. */
  const pendingTools = new Map<string, { tool: string; command?: string }>();
  const toolTrace: TentacleToolTrace[] = [];
  const onAbort = () => harness.cancel?.();
  if (signal?.aborted) {
    onAbort();
    return { result: '', aborted: true };
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
  for await (const ev of harness.run()) {
    if (signal?.aborted) {
      onAbort();
      return {
        result: (lastCompleted || current).trim(),
        ...(error ? { error } : {}),
        aborted: true,
        ...(toolTrace.length > 0 ? { toolTrace } : {}),
      };
    }
    // 2.1 T5 (original-tool-backed evidence): capture the tentacle's raw tool
    // executions mechanically, at execution time — the verify-report note is
    // the agent's claim; this is what the process actually observed.
    if (ev.type === 'tool_execution_start') {
      pendingTools.set(ev.toolCallId, { tool: ev.toolName, command: toolCommandHint(ev.args) });
    } else if (ev.type === 'tool_execution_end') {
      const started = pendingTools.get(ev.toolCallId);
      pendingTools.delete(ev.toolCallId);
      toolTrace.push({
        tool: started?.tool ?? 'unknown',
        callId: ev.toolCallId,
        ok: !ev.isError,
        ...(started?.command ? { command: started.command } : {}),
        output: String(ev.result ?? '').slice(0, TOOL_TRACE_OUTPUT_MAX),
        durationMs: ev.durationMs,
        endedAt: Date.now(),
      });
      if (toolTrace.length > TOOL_TRACE_RING) {
        toolTrace.splice(0, toolTrace.length - TOOL_TRACE_RING);
      }
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
        // Fase 10: capture provider-reported usage (summed across the
        // sub-agent's tool-loop turns) so candidate token costs are real,
        // never approximated.
        if (ev.usage) {
          usage = usage
            ? {
                promptTokens: usage.promptTokens + ev.usage.promptTokens,
                completionTokens: usage.completionTokens + ev.usage.completionTokens,
                totalTokens: usage.totalTokens + ev.usage.totalTokens,
                ...((usage.cachedPromptTokens ?? 0) + (ev.usage.cachedPromptTokens ?? 0) > 0
                  ? {
                      cachedPromptTokens:
                        (usage.cachedPromptTokens ?? 0) + (ev.usage.cachedPromptTokens ?? 0),
                    }
                  : {}),
              }
            : ev.usage;
        }
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
  return {
    result,
    ...(error ? { error } : {}),
    ...(usage ? { usage } : {}),
    ...(toolTrace.length > 0 ? { toolTrace } : {}),
  };
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
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
  /**
   * Provider-reported token usage summed across the sub-agent's turns
   * (Fase 10 metrics). Absent when the provider reports none — never
   * approximated.
   */
  usage?: UsageBreakdown;
  /**
   * 2.1 T5: raw tool executions captured during the run (bounded ring,
   * output excerpts). The verify-report path stores them with the check
   * results so the strict gate can anchor evidence to real tool output.
   */
  toolTrace?: TentacleToolTrace[];
  /** Git worktree path if one was used, else null. */
  worktreePath: string | null;
  /**
   * Full worktree handle when one was created (regardless of deferMerge),
   * else null. The graph executor (F3) uses this to merge/cleanup explicitly
   * when `deferMerge` was requested.
   */
  worktreeHandle: WorktreeHandle | null;
  /** Cognitive-memory node created from this concise conclusion, if enabled. */
  memoryId?: string;
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
    acceptance: withKrakenRequiredChecks(agent, args.acceptance),
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
    buildLiveness: {
      mutationRequired: agent === 'general',
      maxRecoveries: 2,
    },
    cwd: runCwd,
    maxToolCallsPerTurn: maxToolCalls,
    maxToolLoopIterations: Math.max(12, maxToolCalls + 4),
    ...(deps.memoryService
      ? {
          memoryService: deps.memoryService,
          memoryQuery: `${args.description}\n${userContent}`,
          memoryContextChars: 2_400,
        }
      : {}),
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

  const { result, error, aborted, usage, toolTrace } = await runSubAgent(harness, {
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

  let memoryId: string | undefined;
  if (deps.memoryService && deps.memoryAutoWrite !== false) {
    try {
      const verifyPass = agent === 'verify' && /(?:VERDICT:\s*PASS|status:\s*pass)/i.test(result);
      const memory = await deps.memoryService.remember({
        kind: agent === 'verify' ? 'verification' : agent === 'general' ? 'outcome' : 'finding',
        content: result.slice(0, 12_000),
        importance: agent === 'general' ? 0.75 : 0.65,
        confidence: verifyPass ? 0.98 : agent === 'verify' ? 0.7 : 0.72,
        tags: ['kraken', `tentacle:${agent}`],
        source: {
          agent: `kraken-${agent}`,
          sessionId,
          tentacleId: opts.nodeId ?? liveId,
          ...(worktree?.path ? { worktree: worktree.path } : {}),
        },
        metadata: {
          writeClass: agent === 'verify' || agent === 'general' ? 'auto' : 'candidate',
          description: args.description,
          scope: args.scope ?? [],
          acceptance: args.acceptance ?? [],
          graphId: opts.graphId,
          nodeId: opts.nodeId,
          verified: verifyPass,
        },
        writeClass: agent === 'verify' || agent === 'general' ? 'auto' : 'candidate',
      });
      memoryId = memory.id;
    } catch {
      // Shared memory is fail-open: a persistence issue never fails the tentacle.
    }
  }

  return {
    ok: true,
    agent,
    thoroughness,
    model: sub.model,
    result,
    footer,
    ...(usage ? { usage } : {}),
    ...(toolTrace && toolTrace.length > 0 ? { toolTrace } : {}),
    worktreePath: worktree?.path ?? null,
    worktreeHandle: worktree,
    ...(memoryId ? { memoryId } : {}),
  };
}

/** Build the `task` tool from injected sub-agent deps. */
export function createTaskTool(
  deps: TaskToolDeps,
  policy: TaskToolPolicy = {},
): ToolDefinition<TaskArgs & { purpose?: 'candidate' }, { result: string; agent: string }> {
  const allowedAgents: readonly TaskAgentKind[] =
    policy.allowedAgents ?? ['explore', 'general', 'verify'];
  const restricted =
    policy.allowedAgents !== undefined &&
    !(
      policy.allowedAgents.includes('explore') &&
      policy.allowedAgents.includes('general') &&
      policy.allowedAgents.includes('verify')
    );
  // When restricted, narrow the zod enum too so conforming providers cannot
  // emit a disallowed kind (belt) on top of the execute-time gate (braces).
  const inputSchema = restricted
    ? TaskArgsSchema.extend({
        agent: z
          .enum(allowedAgents as unknown as [TaskAgentKind, ...TaskAgentKind[]])
          .optional()
          .describe(
            `Sub-agent type. In this mode ONLY ${allowedAgents.join('|')} is allowed ` +
              '(plan-safe read-only tentacles).',
          ),
      })
    : TaskArgsSchema;
  return {
    name: 'task',
    description:
      'Delegate a focused sub-task to an isolated sub-agent with its own context; ' +
      'returns only a concise conclusion (keeps parent context lean).\n' +
      '- agent=explore (default): read-only research/search\n' +
      '- agent=general: can edit files for one bounded unit of work\n' +
      '- agent=verify: read + bash to run tests/checks\n' +
      'Provide a fully self-contained `prompt` (sub-agent cannot see this conversation). ' +
      'Optional scope[] + acceptance[] contracts. After general, follow up with verify.' +
      (restricted
        ? `\nRESTRICTED in this mode: only agent=${allowedAgents.join('|')} is allowed.`
        : ''),
    permissions: ['read', 'network', 'write', 'execute'],
    timeoutMs: TASK_TOOL_TIMEOUT_MS,
    inputSchema,
    execute: async (args, ctx): Promise<TypedResult<{ result: string; agent: string }>> => {
      const agent: TaskAgentKind = args.agent ?? 'explore';
      let candidateSlot = 0;
      // Fase 1 (ADR-0020): policy gate BEFORE the spawn budget — a rejected
      // kind must not consume the per-turn tentacle budget.
      if (!allowedAgents.includes(agent)) {
        return typedErr(
          `task: agent=${agent} is not allowed in this mode. Allowed: ${allowedAgents.join(', ')} ` +
            '(plan-safe read-only tentacles). Re-issue with an allowed agent kind.',
        );
      }
      // Fase 3 (ADR-0020): candidate contract — explore-only, flag-gated,
      // capped per turn. Checked BEFORE the spawn budget (same rule as the
      // policy gate: a rejected candidate must not consume the budget).
      const isCandidate = args.purpose === 'candidate';
      if (isCandidate) {
        if (!isKrakenSelectionEnabled()) {
          return typedErr(
            'task: purpose=candidate requires ZELARI_KRAKEN_SELECTION=1 (alpha feature). ' +
              'Spawn a plain explore tentacle instead.',
          );
        }
        if (agent !== 'explore') {
          return typedErr(
            'task: purpose=candidate forces agent=explore (candidates are read-only ' +
              'in v1 — zero candidate implementations, ADR-0020).',
          );
        }
        const slot = reserveCandidateSlot();
        if ('error' in slot) return typedErr(slot.error);
        candidateSlot = slot.index;
      }
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
        // Fase 1 (ADR-0020): propagate the parent turn's cancellation signal
        // so cancel/timeout unwinds the tentacle instead of letting it run on.
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(isCandidate
          ? {
              systemPromptOverride:
                systemPromptForAgent('explore') +
                '\n\n' +
                candidateInstructions(candidateSlot),
            }
          : {}),
      });

      // Fase 3 (ADR-0020): register the structured report (malformed reports
      // are preserved as degraded evidence, never dropped). The parent still
      // sees the full conclusion text including the <candidate-report> block.
      if (isCandidate) {
        // Fase 10: real provider-reported tokens (0 when unreported/failed).
        recordCandidateTokens(res.ok ? res.usage?.totalTokens ?? 0 : 0);
        if (res.ok) {
          const parsed = parseCandidateReport(res.result);
          registerCandidate(
            parsed.ok
              ? {
                  status: 'ok' as const,
                  index: candidateSlot,
                  description: args.description,
                  report: parsed.report,
                  raw: res.result,
                }
              : {
                  status: 'malformed' as const,
                  index: candidateSlot,
                  description: args.description,
                  error: parsed.error,
                  raw: res.result,
                },
          );
        } else {
          // Failed tentacle: the slot is consumed and tracked as malformed
          // (no report arrived — degraded by definition).
          registerCandidate({
            status: 'malformed' as const,
            index: candidateSlot,
            description: args.description,
            error: res.error,
            raw: '',
          });
        }
      }
      // Fase 7 (ADR-0020): structured verification — the verify tentacle
      // reports pass/fail/unknown per required check. A failed tentacle or
      // a missing block leaves checks `unknown`: a degraded observation is
      // never proof. Only runs when a selection exists this turn (required
      // checks come from a `selected` verdict — Fase 6 routing).
      if (agent === 'verify') {
        const required = krakenRequiredChecks();
        if (required.length > 0) {
          setKrakenCheckResults(
            res.ok
              ? parseVerifyReport(res.result, required)
              : allUnknownCheckResults(required, `verify tentacle failed: ${res.error}`),
            res.ok ? res.toolTrace : undefined,
          );
        }
      }
      if (!res.ok) return typedErr(res.error);
      return typedOk({
        result: `[sub-agent:${res.agent}/${res.thoroughness} model=${res.model}]\n${res.result}${res.footer}`,
        agent: res.agent,
      });
    },
  };
}
