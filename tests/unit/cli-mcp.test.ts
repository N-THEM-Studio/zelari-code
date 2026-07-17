/**
 * cli-mcp.test.ts — v0.7.5 minimal MCP stdio client coverage.
 *
 * Spawns a REAL child process (node running a fake MCP server written to a
 * temp .cjs file) and drives the full protocol slice: initialize handshake,
 * tools/list discovery, tools/call execution, error propagation.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpClient } from '../../src/cli/mcp/mcpClient.js';
import { readMcpConfig, registerMcpTools, _resetMcpForTests } from '../../src/cli/mcp/mcpManager.js';
import { ToolRegistry } from '@zelari/core/harness/tools/registry';

const FAKE_SERVER = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(o) { process.stdout.write(JSON.stringify(o) + '\\n'); }
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    // Also emit some non-JSON noise: real servers log to stdout sometimes.
    process.stdout.write('fake-mcp-server booting...\\n');
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fake', version: '1.0.0' } } });
  } else if (msg.method === 'notifications/initialized') {
    // notification — no response
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'echo_upper', description: 'uppercase echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
      { name: 'always_error', description: 'always fails', inputSchema: { type: 'object', properties: {} } },
    ] } });
  } else if (msg.method === 'tools/call') {
    const args = (msg.params && msg.params.arguments) || {};
    if (msg.params.name === 'echo_upper') {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(args.text || '').toUpperCase() }] } });
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'boom' }] } });
    }
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});
`;

let dir: string;
let serverScript: string;

beforeAll(() => {
  // Hermetic: never merge the developer's ~/.zelari-code/mcp.json into fixtures.
  process.env['ZELARI_MCP_USER'] = '0';
  dir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
  serverScript = join(dir, 'fake-mcp.cjs');
  writeFileSync(serverScript, FAKE_SERVER);
});
afterAll(() => {
  delete process.env['ZELARI_MCP_USER'];
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  _resetMcpForTests();
});

describe('McpClient (fake stdio server)', () => {
  it('initialize → tools/list → tools/call round-trip', { timeout: 20_000 }, async () => {
    const client = new McpClient('fake', { command: 'node', args: [serverScript] });
    try {
      await client.start();
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['echo_upper', 'always_error']);
      expect(tools[0]!.inputSchema).toMatchObject({ type: 'object' });

      const out = await client.callTool('echo_upper', { text: 'ciao zelari' });
      expect(out).toBe('CIAO ZELARI');

      await expect(client.callTool('always_error', {})).rejects.toThrow('boom');
    } finally {
      client.close();
    }
  });
});

describe('readMcpConfig', () => {
  it('reads Claude-Desktop-shaped config from .zelari/mcp.json', () => {
    const root = join(dir, 'proj-a');
    mkdirSync(join(root, '.zelari'), { recursive: true });
    writeFileSync(join(root, '.zelari', 'mcp.json'), JSON.stringify({
      mcpServers: { fake: { command: 'node', args: ['x.cjs'] }, broken: { args: ['no-command'] } },
    }));
    const cfg = readMcpConfig(root);
    expect(Object.keys(cfg)).toEqual(['fake']); // entry without command is dropped
    expect(cfg['fake']!.command).toBe('node');
  });

  it('returns empty object when no config exists', () => {
    expect(readMcpConfig(join(dir, 'nope'))).toEqual({});
  });
});

describe('registerMcpTools', () => {
  it('discovers and registers namespaced tools that execute end-to-end', { timeout: 20_000 }, async () => {
    const root = join(dir, 'proj-b');
    mkdirSync(join(root, '.zelari'), { recursive: true });
    writeFileSync(join(root, '.zelari', 'mcp.json'), JSON.stringify({
      mcpServers: { fake: { command: 'node', args: [serverScript] } },
    }));

    const registry = new ToolRegistry();
    const { registered, warnings } = await registerMcpTools(registry, root);
    expect(warnings).toEqual([]);
    expect(registered).toContain('mcp_fake_echo_upper');
    expect(registry.list()).toContain('mcp_fake_echo_upper');

    // The provider-facing schema is the server's JSON Schema, not z.any().
    const openai = registry.toOpenAITools().find((t) => t.function.name === 'mcp_fake_echo_upper');
    expect(openai?.function.parameters).toMatchObject({ type: 'object', required: ['text'] });

    const res = await registry.invoke<string>('mcp_fake_echo_upper', { text: 'hi' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe('HI');
  });

  it('is disabled by ZELARI_MCP=0', async () => {
    process.env['ZELARI_MCP'] = '0';
    try {
      const registry = new ToolRegistry();
      const { registered } = await registerMcpTools(registry, join(dir, 'proj-b'));
      expect(registered).toEqual([]);
    } finally {
      delete process.env['ZELARI_MCP'];
    }
  });

  it('collects a warning (once) for a server that fails to start', { timeout: 20_000 }, async () => {
    const root = join(dir, 'proj-c');
    mkdirSync(join(root, '.zelari'), { recursive: true });
    writeFileSync(join(root, '.zelari', 'mcp.json'), JSON.stringify({
      mcpServers: { dead: { command: 'node', args: ['-e', 'process.exit(3)'] } },
    }));
    const registry = new ToolRegistry();
    const first = await registerMcpTools(registry, root);
    expect(first.registered).toEqual([]);
    expect(first.warnings.length).toBe(1);
    expect(first.warnings[0]).toContain('[mcp:dead]');
    // Second call: no re-spawn, warnings already drained.
    const second = await registerMcpTools(registry, root);
    expect(second.warnings).toEqual([]);
  });
});
