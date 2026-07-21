/**
 * taskTool — delegate a bounded sub-task to an isolated sub-agent.
 *
 * Isolation & safety:
 *   - explore / verify: READ-ONLY (or read+bash for verify)
 *   - general: full tools except nested `task` (no recursion)
 *   - Parent gets only a short conclusion, not the full sub-transcript
 *
 * @since v0.7.x · typed agents v1.21.0
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
}

/** A minimal harness surface — just the event stream. */
export interface SubAgentHarness {
  run(): AsyncIterable<BrainEvent>;
}

export interface TaskToolDeps {
  /**
   * Build provider + tool registry for one sub-agent run.
   * `agent` selects tool set (explore RO / general write / verify tests).
   */
  createSubAgentContext: (opts: {
    agent: TaskAgentKind;
    thoroughness: TaskThoroughness;
  }) => Promise<SubAgentContext | null>;
  /** Construct the harness. Overridable in tests; defaults to AgentHarness. */
  harnessFactory?: (config: AgentHarnessConfig) => SubAgentHarness;
}

const EXPLORE_PROMPT = [
  'You are a focused EXPLORE sub-agent for a parent coding agent.',
  'READ-ONLY tools only (read, list, grep, fetch). No edits, no shell.',
  'Gather only what you need, then STOP with a concise conclusion:',
  'file paths, symbols, line refs, and how things connect. No large dumps.',
  'Do not ask follow-up questions.',
].join('\n');

const GENERAL_PROMPT = [
  'You are a GENERAL sub-agent that can read AND modify the codebase for one',
  'bounded unit of work. Prefer small, correct edits. Run checks when needed.',
  'Return a short report: what changed, files touched, remaining risks.',
  'Do not spawn further sub-agents. Do not expand scope beyond the prompt.',
].join('\n');

const VERIFY_PROMPT = [
  'You are a VERIFY sub-agent. Confirm whether work is correct on disk.',
  'You may read files and run test/build commands via bash. Prefer',
  'targeted checks over full suite when possible.',
  'Report: pass/fail, commands run, key output, and gaps.',
].join('\n');

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
        'to this conversation, so include all context it needs.',
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
export function createTaskTool(deps: TaskToolDeps): ToolDefinition<TaskArgs, { result: string; agent: string }> {
  return {
    name: 'task',
    description:
      'Delegate a focused sub-task to an isolated sub-agent with its own context; ' +
      'returns only a concise conclusion (keeps parent context lean).\n' +
      '- agent=explore (default): read-only research/search\n' +
      '- agent=general: can edit files for one bounded unit of work\n' +
      '- agent=verify: read + bash to run tests/checks\n' +
      'Provide a fully self-contained `prompt` (sub-agent cannot see this conversation).',
    permissions: ['read', 'network', 'write', 'execute'],
    timeoutMs: 300_000,
    inputSchema: TaskArgsSchema,
    execute: async (args, ctx): Promise<TypedResult<{ result: string; agent: string }>> => {
      const agent: TaskAgentKind = args.agent ?? 'explore';
      const thoroughness: TaskThoroughness = args.thoroughness ?? 'medium';

      let sub: SubAgentContext | null;
      try {
        sub = await deps.createSubAgentContext({ agent, thoroughness });
      } catch (err) {
        return typedErr(
          `task: could not initialize sub-agent — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!sub) {
        return typedErr(
          'task: no provider configured for the sub-agent (set an API key / run /login).',
        );
      }

      const maxToolCalls = maxToolCallsForThoroughness(thoroughness, agent);
      const config: AgentHarnessConfig = {
        model: sub.model,
        provider: sub.provider,
        messages: [
          { role: 'system', content: systemPromptForAgent(agent) },
          { role: 'user', content: args.prompt },
        ],
        tools: sub.tools,
        toolRegistry: sub.registry,
        providerStream: sub.providerStream,
        cwd: ctx.cwd,
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
        return typedErr(
          `task: failed to start sub-agent — ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const { result, error } = await runSubAgent(harness);
      if (!result) {
        return typedErr(
          `task: sub-agent (${agent}) produced no output${error ? ` (${error})` : ''}.`,
        );
      }
      return typedOk({
        result: `[sub-agent:${agent}/${thoroughness}]\n${result}`,
        agent,
      });
    },
  };
}
