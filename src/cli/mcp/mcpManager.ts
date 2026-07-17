/**
 * mcpManager — MCP server lifecycle + tool registration (v0.7.5).
 *
 * Reads MCP server definitions from (project wins on name conflicts):
 *   1. <project>/.zelari/mcp.json
 *   2. ~/.zelari-code/mcp.json
 *
 * Config format is Claude-Desktop-compatible so existing configs can be
 * copied verbatim:
 *   { "mcpServers": { "<name>": { "command": "npx", "args": [...], "env": {...} } } }
 *
 * Servers are started lazily ONCE per CLI process (module-level cache) and
 * their tools registered into each turn's ToolRegistry as
 * `mcp_<server>_<tool>`. A server that fails to start is skipped and not
 * retried for the rest of the session (a broken server must not add a
 * spawn-timeout to every prompt).
 *
 * Kill switch: ZELARI_MCP=0 disables everything.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { ToolRegistry } from '@zelari/core/harness/tools/registry';
import { typedOk, typedErr, type TypedResult } from '@zelari/core/harness/tools/toolTypes';
import { McpClient, type McpServerConfig, type McpToolInfo } from './mcpClient.js';

interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
}

/** A discovered tool bound to its client, ready to register. */
interface DiscoveredTool {
  registryName: string;
  serverName: string;
  info: McpToolInfo;
  client: McpClient;
}

/** Module-level session cache. */
const state: {
  loaded: boolean;
  tools: DiscoveredTool[];
  warnings: string[];
  clients: McpClient[];
} = { loaded: false, tools: [], warnings: [], clients: [] };

/**
 * Read + merge MCP config files (project entries win on name conflict).
 *
 * Sources (in order, later wins):
 *   1. ~/.zelari-code/mcp.json  — skipped when `ZELARI_MCP_USER=0` (tests /
 *      hermetic CI that must not see the developer's personal servers)
 *   2. <project>/.zelari/mcp.json
 */
export function readMcpConfig(projectRoot: string = process.cwd()): Record<string, McpServerConfig> {
  const merged: Record<string, McpServerConfig> = {};
  const paths: string[] = [];
  // Opt out of the user-global config so unit tests don't pick up real MCP
  // servers installed on the developer machine (merge would otherwise leak
  // github/memory/filesystem/… into hermetic fixtures).
  if (process.env['ZELARI_MCP_USER'] !== '0') {
    paths.push(join(homedir(), '.zelari-code', 'mcp.json'));
  }
  paths.push(join(projectRoot, '.zelari', 'mcp.json')); // later = higher precedence
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as McpConfigFile;
      for (const [name, cfg] of Object.entries(parsed.mcpServers ?? {})) {
        if (!cfg || typeof cfg.command !== 'string' || cfg.command.length === 0) continue;
        merged[name] = cfg;
      }
    } catch {
      // Malformed config file — skip it; the other source may still work.
    }
  }
  return merged;
}

/** Start configured servers (once per process) and discover their tools. */
async function ensureLoaded(projectRoot: string): Promise<void> {
  if (state.loaded) return;
  state.loaded = true; // set FIRST — a throwing server must not cause retry storms

  const servers = readMcpConfig(projectRoot);
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.enabled === false) continue;
    const client = new McpClient(name, cfg);
    try {
      await client.start();
      const tools = await client.listTools();
      state.clients.push(client);
      for (const info of tools) {
        state.tools.push({
          registryName: sanitizeToolName(`mcp_${name}_${info.name}`),
          serverName: name,
          info,
          client,
        });
      }
    } catch (err) {
      client.close();
      state.warnings.push(`[mcp:${name}] disabled: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** OpenAI tool names must match ^[a-zA-Z0-9_-]{1,64}$. */
function sanitizeToolName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

/**
 * Register all discovered MCP tools into a ToolRegistry. Returns warnings
 * collected during (first-time) discovery so the caller can surface them.
 *
 * Safe to call on every turn: discovery runs once, registration is an
 * upsert into the fresh per-turn registry.
 */
export async function registerMcpTools(
  registry: ToolRegistry,
  projectRoot: string = process.cwd(),
): Promise<{ registered: string[]; warnings: string[] }> {
  if (process.env['ZELARI_MCP'] === '0') return { registered: [], warnings: [] };
  await ensureLoaded(projectRoot);

  const registered: string[] = [];
  for (const t of state.tools) {
    registry.register({
      name: t.registryName,
      description: `[MCP:${t.serverName}] ${t.info.description}`.slice(0, 1024),
      // The MCP server owns validation; its JSON Schema is forwarded to the
      // provider via toOpenAITools, so the model sees the real parameter
      // shape even though the local zod gate is permissive.
      permissions: ['network'],
      inputSchema: z.any(),
      // Some registries introspect this for provider tool schemas.
      jsonSchema: t.info.inputSchema,
      execute: async (input: unknown): Promise<TypedResult<string>> => {
        try {
          const args = (input ?? {}) as Record<string, unknown>;
          const text = await t.client.callTool(t.info.name, args);
          return typedOk(text);
        } catch (err) {
          return typedErr(`[${t.registryName}] ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    } as never);
    registered.push(t.registryName);
  }
  // Drain warnings: they are surfaced to the chat ONCE (first turn after
  // discovery), not repeated on every subsequent prompt.
  const warnings = state.warnings.splice(0, state.warnings.length);
  return { registered, warnings };
}

/** Shut down all MCP servers (process exit path). */
export function closeMcpClients(): void {
  for (const c of state.clients) c.close();
  state.clients = [];
  state.tools = [];
  state.loaded = false;
  state.warnings = [];
}

/** Test hook: reset the module cache. */
export function _resetMcpForTests(): void {
  closeMcpClients();
}
