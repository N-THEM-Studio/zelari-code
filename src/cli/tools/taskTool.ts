/**
 * taskTool — delegate a bounded sub-task to an isolated sub-agent.
 *
 * The `task` tool lets the main agent spin up a fresh, read-only sub-agent
 * that runs a focused exploration/analysis task in ITS OWN context and
 * returns only a short conclusion. This keeps the main conversation lean on
 * large repos: instead of the parent burning thousands of tokens reading 20
 * files to answer "where is X handled?", it delegates, and only the answer
 * comes back.
 *
 * Isolation & safety:
 *   - The sub-agent gets a READ-ONLY tool registry (read_file, list_files,
 *     grep_content, show_diff, fetch_url, web_search) — no write/edit/bash —
 *     and, crucially, no `task` tool of its own, so sub-agents cannot recurse.
 *   - Its messages are a fresh [system, user] pair; the parent transcript is
 *     never shared, and only the final assistant message returns to the parent.
 *   - The underlying AgentHarness self-bounds at 12 tool-loop turns, so a
 *     sub-agent can't run away; the tool also carries a long timeout.
 *
 * The provider/registry factory and the harness constructor are injected
 * (`TaskToolDeps`) so the whole flow is unit-testable without a real provider.
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

/** Everything a sub-agent needs to run, built fresh per invocation. */
export interface SubAgentContext {
  providerStream: ProviderStreamFn;
  model: string;
  provider: string;
  registry: ToolRegistry;
  tools: AgentToolSpec[];
}

/** A minimal harness surface — just the event stream. */
export interface SubAgentHarness {
  run(): AsyncIterable<BrainEvent>;
}

export interface TaskToolDeps {
  /**
   * Build an isolated, read-only provider + tool registry for one sub-agent
   * run. Returns null when no provider is configured (missing API key) so the
   * tool can report a friendly error instead of throwing.
   */
  createSubAgentContext: () => Promise<SubAgentContext | null>;
  /** Construct the harness. Overridable in tests; defaults to AgentHarness. */
  harnessFactory?: (config: AgentHarnessConfig) => SubAgentHarness;
}

export const SUBAGENT_SYSTEM_PROMPT = [
  'You are a focused sub-agent spawned to answer ONE bounded question or',
  'complete ONE small research task for a parent coding agent.',
  '',
  'You have READ-ONLY tools (read files, list files, search, fetch URLs).',
  'You cannot edit files or run shell commands — do not attempt to.',
  '',
  'Work efficiently: gather only what you need, then STOP and reply with a',
  'concise, self-contained conclusion the parent can act on. Include concrete',
  'references (file paths, line numbers, symbol names) but do not paste large',
  'file dumps. Do not ask the parent follow-up questions — deliver your best',
  'answer with what you can find.',
].join('\n');

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
        // Keep the most recent non-empty message as the running conclusion.
        if (current.trim()) lastCompleted = current;
        current = '';
        break;
      case 'error':
        // Cancellations arrive as error events; record the message.
        error = ev.message;
        break;
      default:
        break;
    }
  }
  // A run that ended mid-stream (no message_end) still has buffered text.
  const result = (lastCompleted || current).trim();
  return { result, ...(error ? { error } : {}) };
}

/** Build the `task` tool from injected sub-agent deps. */
export function createTaskTool(deps: TaskToolDeps): ToolDefinition<TaskArgs, { result: string }> {
  return {
    name: 'task',
    description:
      'Delegate a focused, READ-ONLY research/exploration sub-task to an isolated ' +
      'sub-agent that has its own fresh context and returns only a concise conclusion. ' +
      'Use it to keep your own context lean — e.g. "find where feature X is implemented ' +
      'and summarize how it works" — on large codebases. The sub-agent cannot edit files ' +
      'or run shell commands. Provide a fully self-contained `prompt` (it cannot see this ' +
      'conversation).',
    // The sub-agent reads the workspace and may hit the network (fetch/search),
    // but never writes or runs shell commands.
    permissions: ['read', 'network'],
    // Sub-agents run a full (bounded) agent loop — allow generous wall time.
    timeoutMs: 300_000,
    inputSchema: TaskArgsSchema,
    execute: async (args, ctx): Promise<TypedResult<{ result: string }>> => {
      let sub: SubAgentContext | null;
      try {
        sub = await deps.createSubAgentContext();
      } catch (err) {
        return typedErr(`task: could not initialize sub-agent — ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!sub) {
        return typedErr('task: no provider configured for the sub-agent (set an API key / run /login).');
      }
      const config: AgentHarnessConfig = {
        model: sub.model,
        provider: sub.provider,
        messages: [
          { role: 'system', content: SUBAGENT_SYSTEM_PROMPT },
          { role: 'user', content: args.prompt },
        ],
        tools: sub.tools,
        toolRegistry: sub.registry,
        providerStream: sub.providerStream,
        cwd: ctx.cwd,
        // Guard against a single turn ballooning context on "explore" tasks.
        maxToolCallsPerTurn: 5,
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
        return typedErr(`task: failed to start sub-agent — ${err instanceof Error ? err.message : String(err)}`);
      }
      const { result, error } = await runSubAgent(harness);
      if (!result) {
        return typedErr(`task: sub-agent produced no output${error ? ` (${error})` : ''}.`);
      }
      return typedOk({ result });
    },
  };
}
