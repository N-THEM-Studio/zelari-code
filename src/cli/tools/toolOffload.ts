/**
 * toolOffload — keep rarely used tool schemas out of every request.
 *
 * Tool schemas ride on EVERY request. The 2026-09 token audit (736 real user
 * turns) found 37 built-in schemas (~8.4K tokens) plus 52 MCP schemas
 * (~9.2K tokens) on each call, while most of them were used in under 1% of
 * turns — ten built-ins never, the MCP filesystem tools mostly as
 * duplicates of read_file/edit/write_file.
 *
 * By default (`ZELARI_TOOL_OFFLOAD=0` opts out) the request carries only the
 * tools real turns use (≥ ~1% of turns, or a mode depends on them) plus ONE dispatcher,
 * `use_tool`. The rest stay registered: the system prompt names them, and
 * `use_tool` returns a schema on request and runs the tool through
 * `ToolRegistry.invoke` — the same choke-point (phase gate, sandbox,
 * permissions, hooks) a direct call goes through.
 *
 * Cache: the offloaded set is fixed for the process (registry order is not
 * used: names are sorted), so the tools array and the pointer text are
 * byte-identical on every request. Nothing is loaded mid-conversation.
 */
import { z } from 'zod';
import type { AgentToolSpec } from '@zelari/core/harness';
import type { ToolRegistry } from '@zelari/core/harness/tools/registry';
import { typedErr, typedOk, type ToolDefinition } from '@zelari/core/harness/tools/toolTypes';

/** Default ON; `0` / `false` / `no` / `off` keep every schema in the request. */
export function isToolOffloadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.ZELARI_TOOL_OFFLOAD ?? '').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(v);
}

/**
 * Built-in tools that stay in every request: used in ≥ ~1% of real turns in
 * the audit, or required by a mode (ask_user for clarifications,
 * inspect_command for the plan phase). Everything else — and every MCP
 * tool — is offloaded.
 */
export const STATIC_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'bash',
  'grep_content',
  'task',
  'edit',
  'todo_write',
  'observe_batch',
  'write_file',
  'list_files',
  'exec_process',
  'task_update',
  'task_create',
  'task_list',
  'fetch_url',
  'record_world_observation',
  'update_world_hypothesis',
  'inspect_command',
  'ask_user',
  'run_backtest',
]);

export const USE_TOOL_NAME = 'use_tool';

export interface ToolOffloadPlan {
  staticTools: AgentToolSpec[];
  offloaded: AgentToolSpec[];
  /** Stable system-prompt paragraph naming what `use_tool` can reach. */
  pointer: string;
}

const MCP_PREFIX = /^\[MCP:([^\]]+)\]/;

export function planToolOffload(
  tools: readonly AgentToolSpec[],
  keep: ReadonlySet<string> = STATIC_TOOLS,
): ToolOffloadPlan {
  const staticTools: AgentToolSpec[] = [];
  const offloaded: AgentToolSpec[] = [];
  for (const tool of tools) {
    if (tool.name === USE_TOOL_NAME) continue;
    if (keep.has(tool.name) && !tool.name.startsWith('mcp_')) staticTools.push(tool);
    else offloaded.push(tool);
  }
  offloaded.sort((a, b) => a.name.localeCompare(b.name));
  return { staticTools, offloaded, pointer: offloadPointer(offloaded) };
}

function offloadPointer(offloaded: readonly AgentToolSpec[]): string {
  if (offloaded.length === 0) return '';
  const builtins: string[] = [];
  const servers = new Map<string, number>();
  for (const tool of offloaded) {
    const server = MCP_PREFIX.exec(tool.description ?? '')?.[1];
    if (server) servers.set(server, (servers.get(server) ?? 0) + 1);
    else builtins.push(tool.name);
  }
  const lines = ['# More tools', ''];
  lines.push(
    `These tools are available through \`${USE_TOOL_NAME}\` rather than as direct calls. ` +
      `\`${USE_TOOL_NAME}({"name": "<tool>", "describe": true})\` returns a tool's description and argument schema; ` +
      `\`${USE_TOOL_NAME}({"name": "<tool>", "args": {…}})\` runs it.`,
  );
  if (builtins.length > 0) lines.push('', `Built-in: ${builtins.join(', ')}.`);
  if (servers.size > 0) {
    const list = [...servers.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([server, n]) => `${server} (${n})`)
      .join(', ');
    lines.push(
      '',
      `MCP servers: ${list}. \`${USE_TOOL_NAME}({"server": "<server>", "describe": true})\` lists a server's tools.`,
    );
  }
  return lines.join('\n');
}

const UseToolArgs = z.object({
  name: z.string().min(1).optional(),
  server: z.string().min(1).optional(),
  describe: z.boolean().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The dispatcher. Runs an offloaded tool through `registry.invoke`, so the
 * target's own validation, permissions, phase gate and hooks all apply.
 */
export function createUseToolTool(
  registry: ToolRegistry,
  offloaded: readonly AgentToolSpec[],
): ToolDefinition<z.infer<typeof UseToolArgs>, unknown> {
  const byName = new Map(offloaded.map((t) => [t.name, t]));
  return {
    name: USE_TOOL_NAME,
    description:
      'Describe or run a tool listed under "More tools" in the system prompt. ' +
      '{name, describe: true} returns its description and argument schema; {server, describe: true} lists an MCP server\'s tools; ' +
      '{name, args} runs it and returns its result.',
    permissions: [],
    // The target enforces its own timeout inside registry.invoke.
    timeoutMs: 600_000,
    inputSchema: UseToolArgs,
    execute: async (input, ctx) => {
      if (input.server && input.describe) {
        const tools = offloaded
          .filter((t) => MCP_PREFIX.exec(t.description ?? '')?.[1] === input.server)
          .map((t) => ({ name: t.name, description: t.description }));
        if (tools.length === 0) return typedErr(`use_tool: no MCP server named "${input.server}" in the More tools list.`);
        return typedOk({ server: input.server, tools });
      }
      if (!input.name) return typedErr('use_tool: pass "name" (or "server" with describe: true).');
      const target = byName.get(input.name);
      if (!target) {
        return typedErr(
          registry.get(input.name)
            ? `use_tool: ${input.name} is in your tool list — call it directly.`
            : `use_tool: no tool named "${input.name}" under More tools.`,
        );
      }
      if (input.describe) {
        return typedOk({ name: target.name, description: target.description, parameters: target.parameters });
      }
      return registry.invoke(input.name, input.args ?? {}, {
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
        ...(ctx.emitSessionEvent ? { emitSessionEvent: ctx.emitSessionEvent } : {}),
      });
    },
  };
}
