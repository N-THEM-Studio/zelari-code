/**
 * Token audit — size of the MCP tool schemas that ride on every request.
 *
 * Opt-in (`ZELARI_TOKEN_AUDIT=1`). For each server in `<ZELARI_HOME>/mcp.json`
 * it connects, lists the tools, measures what `registerMcpTools` would put on
 * the wire (`[MCP:server] description` + the JSON Schema), and closes the
 * client. Writes `mcp-schemas.json` next to the request captures.
 */
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { McpClient, type McpServerConfig } from '../../src/cli/mcp/mcpClient.js';
import { zelariHome } from '../../src/cli/paths.js';

const enabled = process.env.ZELARI_TOKEN_AUDIT === '1';

describe.skipIf(!enabled)('token audit — MCP schemas', () => {
  it('measures every configured server', async () => {
    const outDir =
      process.env.ZELARI_TOKEN_AUDIT_OUT ?? path.join(os.tmpdir(), 'zelari-token-audit');
    await fs.mkdir(outDir, { recursive: true });
    const cfg = JSON.parse(readFileSync(path.join(zelariHome(), 'mcp.json'), 'utf8')) as {
      mcpServers?: Record<string, McpServerConfig & { disabled?: boolean }>;
    };
    const report: Array<{ server: string; tools: Array<{ name: string; chars: number }>; error?: string }> = [];
    for (const [name, server] of Object.entries(cfg.mcpServers ?? {})) {
      if (server.disabled) continue;
      const client = new McpClient(name, server, process.cwd());
      try {
        await client.start();
        const tools = await client.listTools();
        report.push({
          server: name,
          tools: tools.map((t) => ({
            name: `mcp_${name}_${t.name}`,
            chars: JSON.stringify({
              type: 'function',
              function: {
                name: `mcp_${name}_${t.name}`,
                description: `[MCP:${name}] ${t.description ?? ''}`.slice(0, 1024),
                parameters: t.inputSchema,
              },
            }).length,
          })),
        });
      } catch (err) {
        report.push({ server: name, tools: [], error: err instanceof Error ? err.message : String(err) });
      } finally {
        client.close();
      }
    }
    await fs.writeFile(path.join(outDir, 'mcp-schemas.json'), JSON.stringify(report, null, 1));
    expect(report.length).toBeGreaterThan(0);
  }, 180_000);
});
