/**
 * cli-mcpHttp.test.ts — MCP Streamable HTTP transport coverage.
 *
 * Spins up a REAL node:http fake server speaking the Streamable HTTP
 * transport (Mcp-Session-Id header, JSON + SSE responses, 404 on stale
 * session — the UE 5.8+ editor server shape) and drives McpClient
 * end-to-end: handshake, cursor-paginated tools/list, SSE tools/call,
 * session-loss re-init + replay, serial queue, per-server timeout, and
 * url-based config validation + registration.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { McpClient } from '../../src/cli/mcp/mcpClient.js';
import {
  readMcpConfig,
  registerMcpTools,
  _resetMcpForTests,
} from '../../src/cli/mcp/mcpManager.js';
import { ToolRegistry } from '@zelari/core/harness/tools/registry';

// ── fake Streamable HTTP MCP server ────────────────────────────────────

let session: string | null = null;
let sessionCounter = 0;
let initializeCount = 0;
let inFlight = 0;
let maxInFlight = 0;
let delayMs = 0;
let respondSse = false;

const PAGE1 = [
  {
    name: 'list_toolsets',
    description: 'UE Tool Search meta-tool',
    inputSchema: { type: 'object', properties: {} },
  },
];
const PAGE2 = [
  {
    name: 'call_tool',
    description: 'UE Tool Search meta-tool (call)',
    inputSchema: {
      type: 'object',
      properties: { tool: { type: 'string' } },
      required: ['tool'],
    },
  },
];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  if (req.method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  let msg: { id?: number; method?: string; params?: any } = {};
  try {
    msg = body ? JSON.parse(body) : {};
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  if (msg.method === 'initialize') {
    initializeCount++;
    sessionCounter++;
    session = `s-${sessionCounter}`;
    res.setHeader('content-type', 'application/json');
    res.setHeader('mcp-session-id', session);
    res.writeHead(200);
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          serverInfo: { name: 'fake-http', version: '1.0.0' },
        },
      }),
    );
    return;
  }
  if (msg.id === undefined) {
    res.writeHead(202); // notification accepted
    res.end();
    return;
  }
  const sid = req.headers['mcp-session-id'];
  if (!session || sid !== session) {
    res.writeHead(404); // stale / absent session → session loss
    res.end();
    return;
  }
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    if (delayMs) await sleep(delayMs);
    if (msg.method === 'tools/list') {
      const result =
        msg.params?.cursor === 'p2'
          ? { tools: PAGE2 }
          : { tools: PAGE1, nextCursor: 'p2' };
      res.setHeader('content-type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    } else if (msg.method === 'tools/call') {
      const name = msg.params?.name ?? '';
      if (respondSse) {
        res.setHeader('content-type', 'text/event-stream');
        res.writeHead(200);
        res.write(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text: `sse:${name}` }] },
          })}\n\n`,
        );
        res.end();
      } else {
        res.setHeader('content-type', 'application/json');
        res.writeHead(200);
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text: `json:${name}` }] },
          }),
        );
      }
    } else {
      res.setHeader('content-type', 'application/json');
      res.writeHead(200);
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: 'method not found' },
        }),
      );
    }
  } finally {
    inFlight--;
  }
}

const server: Server = createServer((req, res) => {
  void handle(req, res);
});

let dir: string;
let url: string;

beforeAll(async () => {
  // Hermetic: never merge the developer's ~/.zelari-code/mcp.json.
  process.env['ZELARI_MCP_USER'] = '0';
  process.env['ZELARI_FOLDER_TRUST'] = '1';
  dir = mkdtempSync(join(tmpdir(), 'mcp-http-test-'));
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const port = (server.address() as AddressInfo).port;
  url = `http://127.0.0.1:${port}/mcp`;
});

afterAll(async () => {
  delete process.env['ZELARI_MCP_USER'];
  delete process.env['ZELARI_FOLDER_TRUST'];
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  _resetMcpForTests();
  session = null;
  initializeCount = 0;
  maxInFlight = 0;
  delayMs = 0;
  respondSse = false;
});

// ── McpClient over Streamable HTTP ─────────────────────────────────────

describe('McpClient (fake Streamable HTTP server)', () => {
  it('initialize → tools/list (cursor pagination) → tools/call (SSE)', { timeout: 20_000 }, async () => {
    respondSse = true;
    const client = new McpClient('fake-http', { type: 'http', url });
    try {
      await client.start();
      expect(initializeCount).toBe(1);

      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['list_toolsets', 'call_tool']);
      expect(tools[1]!.inputSchema).toMatchObject({ type: 'object', required: ['tool'] });

      const out = await client.callTool('call_tool', { tool: 'find_actors' });
      expect(out).toBe('sse:call_tool');
    } finally {
      client.close();
    }
  });

  it('session loss (editor restart) → 404 → re-handshake + replay', { timeout: 20_000 }, async () => {
    const client = new McpClient('fake-http', { type: 'http', url });
    try {
      await client.start();
      expect(initializeCount).toBe(1);
      session = null; // simulate editor restart: server forgot the session
      const out = await client.callTool('call_tool', { tool: 'x' });
      expect(out).toBe('json:call_tool');
      expect(initializeCount).toBe(2); // transparent re-handshake
    } finally {
      client.close();
    }
  });

  it('serializes concurrent requests (editor game thread must not overlap)', { timeout: 20_000 }, async () => {
    delayMs = 40;
    const client = new McpClient('fake-http', { type: 'http', url });
    try {
      await client.start();
      const results = await Promise.all([
        client.callTool('call_tool', { tool: 'a' }),
        client.callTool('call_tool', { tool: 'b' }),
        client.callTool('call_tool', { tool: 'c' }),
      ]);
      expect(results).toEqual(['json:call_tool', 'json:call_tool', 'json:call_tool']);
      expect(maxInFlight).toBe(1);
    } finally {
      client.close();
    }
  });

  it('per-server timeout rejects with a clear error', { timeout: 20_000 }, async () => {
    delayMs = 600;
    const client = new McpClient('fake-http', { type: 'http', url, timeoutMs: 150 });
    try {
      await client.start();
      await expect(client.callTool('call_tool', {})).rejects.toThrow(
        /timed out after 150ms/,
      );
    } finally {
      client.close();
    }
  });
});

// ── config parsing + registration (url-based entries) ─────────────────

describe('readMcpConfig / registerMcpTools (http entries)', () => {
  it('accepts url-based entries and drops entries with neither command nor url', () => {
    const root = join(dir, 'proj-http');
    mkdirSync(join(root, '.zelari'), { recursive: true });
    writeFileSync(
      join(root, '.zelari', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          ue: { type: 'http', url, timeoutMs: 5000, serial: true },
          broken: { args: ['no-command-no-url'] },
        },
      }),
    );
    const cfg = readMcpConfig(root);
    expect(Object.keys(cfg)).toEqual(['ue']);
    expect(cfg['ue']!.type).toBe('http');
    expect(cfg['ue']!.url).toBe(url);
  });

  it('discovers and registers UE-style meta-tools end-to-end', { timeout: 20_000 }, async () => {
    const root = join(dir, 'proj-http');
    const registry = new ToolRegistry();
    const { registered, warnings } = await registerMcpTools(registry, root);
    expect(warnings).toEqual([]);
    expect(registered).toContain('mcp_ue_list_toolsets');
    expect(registered).toContain('mcp_ue_call_tool');

    const res = await registry.invoke<string>('mcp_ue_call_tool', {
      tool: 'find_actors',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe('json:call_tool');
  });

  it('keeps an unreachable http server pending (editor not started yet) and retries next turn', { timeout: 20_000 }, async () => {
    const root = join(dir, 'proj-down');
    mkdirSync(join(root, '.zelari'), { recursive: true });
    writeFileSync(
      join(root, '.zelari', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          'editor-down': { type: 'http', url: 'http://127.0.0.1:1/mcp' },
        },
      }),
    );
    const registry = new ToolRegistry();
    const first = await registerMcpTools(registry, root);
    expect(first.registered).toEqual([]);
    expect(first.warnings.some((w) => w.includes('not reachable yet'))).toBe(true);

    // Editor comes up (point the entry at the live fake server): the retry
    // on the next registerMcpTools call picks it up without a CLI restart.
    writeFileSync(
      join(root, '.zelari', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          'editor-down': { type: 'http', url },
        },
      }),
    );
    _resetMcpForTests(); // new process would re-read config
    const registry2 = new ToolRegistry();
    const second = await registerMcpTools(registry2, root);
    expect(second.registered).toContain('mcp_editor-down_call_tool');
  });
});
