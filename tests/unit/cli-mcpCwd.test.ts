/**
 * cli-mcpCwd.test.ts — stdio MCP servers spawn with the session project root as cwd.
 *
 * Regression (v2.41.0 incident): the Desktop launches the CLI from its own
 * install dir; a catalog entry like `server-filesystem "."` inherited that
 * process cwd and jailed itself to the app folder, so every read/write
 * outside it failed with "path outside allowed directories". McpClient now
 * accepts the session project root and passes it as the spawn cwd.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpClient } from '../../src/cli/mcp/mcpClient.js';

const CWD_SERVER = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(o) { process.stdout.write(JSON.stringify(o) + '\\n'); }
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fake-cwd', version: '1.0.0' } } });
  } else if (msg.method === 'notifications/initialized') {
    // notification — no response
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'where', description: 'report child process cwd', inputSchema: { type: 'object', properties: {} } },
    ] } });
  } else if (msg.method === 'tools/call' && msg.params.name === 'where') {
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: process.cwd() }] } });
  }
});
`;

function makeServer(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-cwd-'));
  const script = join(dir, 'fake-cwd.cjs');
  writeFileSync(script, CWD_SERVER);
  return script;
}

describe('McpClient spawn cwd (project-scoped servers)', () => {
  it(
    'stdio server sees the provided project root as process.cwd()',
    { timeout: 20_000 },
    async () => {
      const script = makeServer();
      const projectRoot = mkdtempSync(join(tmpdir(), 'mcp-cwd-root-'));
      const client = new McpClient('fake-cwd', { command: 'node', args: [script] }, projectRoot);
      try {
        await client.start();
        const out = await client.callTool('where', {});
        expect(out).toBe(projectRoot);
      } finally {
        client.close();
        // Windows: the killed child may still hold its cwd - never let
        // best-effort tmp cleanup mask the real assertion (EBUSY).
        await new Promise((r) => setTimeout(r, 150));
        try { rmSync(script, { force: true }); } catch { /* tmp dir */ }
        try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* tmp dir */ }
      }
    },
  );

  it(
    'without spawnCwd the child inherits the parent cwd (back-compat)',
    { timeout: 20_000 },
    async () => {
      const script = makeServer();
      const client = new McpClient('fake-cwd', { command: 'node', args: [script] });
      try {
        await client.start();
        const out = await client.callTool('where', {});
        expect(out).toBe(process.cwd());
      } finally {
        client.close();
        await new Promise((r) => setTimeout(r, 150));
        try { rmSync(script, { force: true }); } catch { /* tmp dir */ }
      }
    },
  );
});
