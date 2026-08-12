/**
 * cli-mcpPermissionServer.test.ts — v1.30.0 MCP stdio server coverage.
 *
 * The `--permission-mcp` child speaks JSON-RPC over stdio to the external
 * agent CLI and forwards approvals to the broker socket. Tests drive the
 * protocol slice (initialize → tools/list → tools/call) through injectable
 * streams with a REAL broker in-process, then (when dist is built) spawn
 * the actual bundled CLI as a child process.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  startPermissionMcpServer,
  PERMISSION_MCP_TOOLS,
} from '../../src/cli/mcp/mcpPermissionServer.js';
import {
  startPermissionBroker,
  type PermissionBrokerHandle,
} from '../../src/cli/mcp/permissionBroker.js';

function makeSocketPath(): string {
  const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\zelari-perm-test-${suffix}`;
  }
  return join(tmpdir(), `zelari-perm-test-${suffix}.sock`);
}

/** Drive the MCP server over injected streams. */
class McpDriver {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  private buffer = '';
  private readonly waiters = new Map<number | string, (msg: Record<string, unknown>) => void>();

  constructor() {
    this.output.setEncoding('utf8');
    this.output.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const w = this.waiters.get(msg.id as number | string);
        if (w) {
          this.waiters.delete(msg.id as number | string);
          w(msg);
        }
      }
    });
  }

  request(method: string, params?: unknown, id = 1): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      this.input.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }) + '\n',
      );
    });
  }

  notify(method: string, params?: unknown): void {
    this.input.write(
      JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }) + '\n',
    );
  }

  end(): void {
    this.input.end();
  }
}

const brokerHandles: PermissionBrokerHandle[] = [];
let serverStop: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (serverStop) {
    await serverStop();
    serverStop = null;
  }
  while (brokerHandles.length > 0) {
    const h = brokerHandles.pop();
    if (h) await h.stop();
  }
});

async function startBrokerAllow() {
  const socketPath = makeSocketPath();
  const h = await startPermissionBroker(socketPath, {
    onPermission: async (req) => ({
      behavior: 'allow',
      always: true,
      message: `ok ${req.tool}`,
    }),
    onQuestion: async (req) => ({
      behavior: 'allow',
      answer: req.choices?.length ? req.choices[0]! : 'yes',
    }),
  });
  brokerHandles.push(h);
  return socketPath;
}

async function startBrokerAllowWithoutAlways() {
  const socketPath = makeSocketPath();
  const h = await startPermissionBroker(socketPath, {
    onPermission: async (req) => ({
      behavior: 'allow',
      message: `ok ${req.tool}`,
    }),
    onQuestion: async (req) => ({
      behavior: 'allow',
      answer: req.choices?.length ? req.choices[0]! : 'yes',
    }),
  });
  brokerHandles.push(h);
  return socketPath;
}

describe('startPermissionMcpServer — protocol slice (in-process)', () => {
  it('initialize returns the server info', async () => {
    const driver = new McpDriver();
    serverStop = (
      await startPermissionMcpServer({ socketPath: makeSocketPath(), input: driver.input, output: driver.output })
    ).stop;
    const res = await driver.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    expect(res.error).toBeUndefined();
    const result = res.result as { protocolVersion: string; serverInfo: { name: string; version: string } };
    expect(result.protocolVersion).toBe('2025-03-26');
    expect(result.serverInfo.name).toBe('zelari-permission-mcp');
    expect(typeof result.serverInfo.version).toBe('string');
  });

  it('tools/list exposes approve + ask_user with schemas', async () => {
    const driver = new McpDriver();
    serverStop = (
      await startPermissionMcpServer({ socketPath: makeSocketPath(), input: driver.input, output: driver.output })
    ).stop;
    const res = await driver.request('tools/list');
    const tools = (res.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(['approve', 'ask_user']);
    expect(tools.find((t) => t.name === 'approve')!.inputSchema.required).toContain('tool_name');
    expect(tools.find((t) => t.name === 'ask_user')!.inputSchema.required).toContain('question');
    expect(PERMISSION_MCP_TOOLS.length).toBe(2);
  });

  it('tools/call approve returns allow + updatedInput via a real broker', async () => {
    const socketPath = await startBrokerAllow();
    const driver = new McpDriver();
    serverStop = (
      await startPermissionMcpServer({ socketPath, input: driver.input, output: driver.output })
    ).stop;
    const res = await driver.request('tools/call', {
      name: 'approve',
      arguments: { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu-1' },
    });
    expect(res.error).toBeUndefined();
    const text = (res.result as { content: Array<{ type: string; text: string }> }).content[0]!.text;
    const parsed = JSON.parse(text) as { behavior: string; updatedInput: unknown };
    expect(parsed.behavior).toBe('allow');
    expect(parsed.updatedInput).toEqual({ command: 'ls' });
  });

  it('tools/call approve returns updatedPermissions only when always + permission_suggestions', async () => {
    const socketPath = await startBrokerAllow();
    const driver = new McpDriver();
    serverStop = (
      await startPermissionMcpServer({ socketPath, input: driver.input, output: driver.output })
    ).stop;
    const res = await driver.request('tools/call', {
      name: 'approve',
      arguments: { tool_name: 'Bash', input: {}, permission_suggestions: [{ tool_name: 'Bash' }] },
    });
    const parsed = JSON.parse((res.result as { content: Array<{ text: string }> }).content[0]!.text);
    expect(parsed.updatedPermissions).toEqual([{ tool_name: 'Bash' }]);
  });

  it('tools/call approve omits updatedPermissions when user did NOT pick always', async () => {
    const socketPath = await startBrokerAllowWithoutAlways();
    const driver = new McpDriver();
    serverStop = (
      await startPermissionMcpServer({ socketPath, input: driver.input, output: driver.output })
    ).stop;
    const res = await driver.request('tools/call', {
      name: 'approve',
      arguments: { tool_name: 'Bash', input: {}, permission_suggestions: [{ tool_name: 'Bash' }] },
    });
    const parsed = JSON.parse((res.result as { content: Array<{ text: string }> }).content[0]!.text);
    expect(parsed.behavior).toBe('allow');
    expect(parsed.updatedPermissions).toBeUndefined();
  });

  it('tools/call approve returns deny with a clear message when the broker is absent', async () => {
    const driver = new McpDriver();
    serverStop = (
      await startPermissionMcpServer({ socketPath: makeSocketPath(), input: driver.input, output: driver.output })
    ).stop;
    const res = await driver.request('tools/call', {
      name: 'approve',
      arguments: { tool_name: 'Bash', input: {} },
    });
    const parsed = JSON.parse((res.result as { content: Array<{ text: string }> }).content[0]!.text);
    expect(parsed.behavior).toBe('deny');
    expect(parsed.message).toContain('unavailable');
  });

  it('tools/call ask_user returns the human answer via a real broker', async () => {
    const socketPath = await startBrokerAllow();
    const driver = new McpDriver();
    serverStop = (
      await startPermissionMcpServer({ socketPath, input: driver.input, output: driver.output })
    ).stop;
    const res = await driver.request('tools/call', {
      name: 'ask_user',
      arguments: { question: 'which plan?', choices: ['A', 'B'] },
    });
    const text = (res.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toBe('A');
  });

  it('rejects invalid params and unknown methods with JSON-RPC errors', async () => {
    const driver = new McpDriver();
    serverStop = (
      await startPermissionMcpServer({ socketPath: makeSocketPath(), input: driver.input, output: driver.output })
    ).stop;
    const badApprove = await driver.request('tools/call', { name: 'approve', arguments: {} });
    expect((badApprove.error as { code: number }).code).toBe(-32602);
    const unknown = await driver.request('tools/call', { name: 'nope', arguments: {} });
    expect((unknown.error as { code: number }).code).toBe(-32602);
    const unknownMethod = await driver.request('bogus/method');
    expect((unknownMethod.error as { code: number }).code).toBe(-32601);
  });

  it('tolerates notifications and non-JSON noise', async () => {
    const driver = new McpDriver();
    serverStop = (
      await startPermissionMcpServer({ socketPath: makeSocketPath(), input: driver.input, output: driver.output })
    ).stop;
    driver.notify('notifications/initialized');
    driver.input.write('booting noise not json\n');
    const res = await driver.request('tools/list');
    expect((res.result as { tools: unknown[] }).tools.length).toBe(2);
  });
});

describe('startPermissionMcpServer — real child process (e2e, requires build)', () => {
  const bundled = join(process.cwd(), 'dist', 'cli', 'main.bundled.js');
  const compiled = join(process.cwd(), 'dist', 'cli', 'main.js');
  const entry = existsSync(bundled) ? bundled : existsSync(compiled) ? compiled : null;

  const skip = !entry
    ? 'dist/cli missing — run `npm run build` to enable the spawn e2e'
    : false;

  it.skipIf(skip)('spawns zelari-code --permission-mcp and round-trips approve', { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'perm-e2e-'));
    const socketPath = makeSocketPath();
    const fakeBroker = join(dir, 'fake-broker.cjs');
    writeFileSync(
      fakeBroker,
      `
const net = require('node:net');
const server = net.createServer((sock) => {
  sock.setEncoding('utf8');
  let buf = '';
  sock.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m && m.t === 'ask') {
        const ans = m.kind === 'permission'
          ? { t: 'answer', id: m.id, behavior: 'allow' }
          : { t: 'answer', id: m.id, behavior: 'allow', answer: 'B' };
        sock.write(JSON.stringify(ans) + '\\n');
      }
    }
  });
});
server.listen(${JSON.stringify(socketPath)}, () => {
  process.stderr.write('fake-broker ready\\n');
});
`,
    );

    const broker = spawn(process.execPath, [fakeBroker]);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('fake broker did not start')), 5_000);
      broker.stderr.on('data', (d: Buffer) => {
        if (String(d).includes('fake-broker ready')) {
          clearTimeout(t);
          resolve();
        }
      });
      broker.on('exit', (code) => reject(new Error(`fake broker exited ${code}`)));
    });

    const child = spawn(process.execPath, [entry!, '--permission-mcp', socketPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let outBuf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      outBuf += d;
    });

    const send = (obj: unknown) => child.stdin.write(JSON.stringify(obj) + '\n');
    const nextResponse = (id: number): Promise<Record<string, unknown>> =>
      new Promise((resolve) => {
        const wait = () => {
          let nl: number;
          while ((nl = outBuf.indexOf('\n')) >= 0) {
            const line = outBuf.slice(0, nl).trim();
            outBuf = outBuf.slice(nl + 1);
            if (!line) continue;
            try {
              const msg = JSON.parse(line);
              if (msg.id === id) return resolve(msg);
            } catch {
              /* ignore */
            }
          }
          setTimeout(wait, 20);
        };
        wait();
      });

    try {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
      const initRes = await nextResponse(1);
      expect((initRes.result as { serverInfo: { name: string } }).serverInfo.name).toBe('zelari-permission-mcp');

      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const listRes = await nextResponse(2);
      expect((listRes.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name).sort()).toEqual(['approve', 'ask_user']);

      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'ls' } } } });
      const callRes = await nextResponse(3);
      const parsed = JSON.parse((callRes.result as { content: Array<{ text: string }> }).content[0]!.text);
      expect(parsed.behavior).toBe('allow');
      expect(parsed.updatedInput).toEqual({ command: 'ls' });

      send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ask_user', arguments: { question: 'pick', choices: ['A', 'B'] } } });
      const askRes = await nextResponse(4);
      const askText = (askRes.result as { content: Array<{ text: string }> }).content[0]!.text;
      expect(askText).toBe('B');
    } finally {
      child.kill();
      broker.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
