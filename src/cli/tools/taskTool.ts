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
 * @since v0.7.x · typed agents v1.21.0 · Kraken contracts v1.x
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
  type WorktreeHandle,
} from './krakenWorktree.js';

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
 */
async function runSubAgent(
  harness: SubAgentHarness,
): Promise<{ result: string; error?: string }> {
  let current = '';
  let lastCompleted = '';
  let error: string | undefined;
  for await (const ev of harness.run()) {
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
      const started = Date.now();
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

      // Optional worktree isolation for general writers (K7).
      let worktree: WorktreeHandle | null = null;
      let effectiveCwd = parentCwd;
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
        return typedErr(
          `task: could not initialize sub-agent — ${err instanceof Error ? err.message : String(err)}`,
        );
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
        return typedErr(
          'task: no provider configured for the sub-agent (set an API key / run /login).',
        );
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
          { role: 'system', content: systemPromptForAgent(agent) },
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
        return typedErr(
          `task: failed to start sub-agent — ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const { result, error } = await runSubAgent(harness);
      const durationMs = Date.now() - started;

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
        return typedErr(
          `task: sub-agent (${agent}) produced no output${error ? ` (${error})` : ''}.`,
        );
      }

      const kept = worktree ? shouldKeepWorktree() : false;
      let footer = '';
      if (worktree) {
        footer += `\n${formatWorktreeFooter(worktree, { kept })}`;
        if (!kept) await cleanupKrakenWorktree(worktree);
      }
      if (agent === 'general') {
        footer += `\n${verifyHintForGeneral(args.acceptance)}`;
        g.__zelariLastGeneralAt = Date.now();
      }

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

      return typedOk({
        result: `[sub-agent:${agent}/${thoroughness} model=${sub.model}]\n${result}${footer}`,
        agent,
      });
    },
  };
}
