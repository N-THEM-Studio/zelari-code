/**
 * mcpClient — minimal Model Context Protocol client over stdio (v0.7.5).
 *
 * Implements exactly the slice of MCP the CLI needs to consume external
 * tool servers: `initialize` handshake, `tools/list` discovery, and
 * `tools/call` execution, speaking newline-delimited JSON-RPC 2.0 over a
 * child process's stdin/stdout (the MCP stdio transport).
 *
 * No SDK dependency on purpose: the protocol slice is ~150 lines and the
 * official SDK would be the CLI's heaviest dependency by far.
 *
 * @see https://modelcontextprotocol.io/specification (stdio transport)
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/** JSON-RPC id → pending resolver. */
interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface McpServerConfig {
  /** Executable (e.g. 'npx', 'node', 'uvx', an absolute path). */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Set false to keep the entry in config but skip it. */
  enabled?: boolean;
}

export interface McpToolInfo {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments (as provided by the server). */
  inputSchema: Record<string, unknown>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const INIT_TIMEOUT_MS = 15_000;
export const MCP_PROTOCOL_VERSION = '2025-03-26';

export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stdoutBuffer = '';
  private closed = false;

  constructor(
    public readonly serverName: string,
    private readonly config: McpServerConfig,
  ) {}

  /** Spawn the server process and run the MCP initialize handshake. */
  async start(): Promise<void> {
    if (this.child) return;
    const child = spawn(this.config.command, this.config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.config.env ?? {}) },
      // On Windows `npx`/`uvx` resolve to .cmd shims which plain spawn
      // cannot execute; shell:true lets cmd.exe resolve them.
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.on('error', (err) => this.failAll(new Error(`[mcp:${this.serverName}] spawn failed: ${err.message}`)));
    child.on('exit', (code) => {
      if (!this.closed) {
        this.failAll(new Error(`[mcp:${this.serverName}] server exited (code ${code ?? 'null'})`));
      }
    });

    await this.request(
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'zelari-code', version: '0.7.5' },
      },
      INIT_TIMEOUT_MS,
    );
    this.notify('notifications/initialized', {});
  }

  /** Discover the server's tools. */
  async listTools(): Promise<McpToolInfo[]> {
    const res = (await this.request('tools/list', {})) as {
      tools?: Array<{ name?: string; description?: string; inputSchema?: Record<string, unknown> }>;
    };
    return (res.tools ?? [])
      .filter((t): t is { name: string; description?: string; inputSchema?: Record<string, unknown> } => !!t.name)
      .map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      }));
  }

  /**
   * Call a tool. Returns the concatenated text content; non-text content
   * items are summarized by type. Throws when the server flags isError.
   */
  async callTool(name: string, args: Record<string, unknown>, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<string> {
    const res = (await this.request('tools/call', { name, arguments: args }, timeoutMs)) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const text = (res.content ?? [])
      .map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : `[${c.type ?? 'unknown'} content]`))
      .join('\n');
    if (res.isError) throw new Error(text || `tool "${name}" reported an error`);
    return text;
  }

  /** Terminate the server process and reject all in-flight requests. */
  close(): void {
    this.closed = true;
    this.failAll(new Error(`[mcp:${this.serverName}] client closed`));
    this.child?.kill();
    this.child = null;
  }

  // ── JSON-RPC plumbing ────────────────────────────────────────────────

  private request(method: string, params: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error(`[mcp:${this.serverName}] not started`));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`[mcp:${this.serverName}] ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(payload + '\n', (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let nl: number;
    while ((nl = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, nl).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string; code?: number } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // servers sometimes log garbage to stdout — ignore non-JSON
      }
      if (typeof msg.id !== 'number') continue; // notification from server — none handled yet
      const pending = this.pending.get(msg.id);
      if (!pending) continue;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new Error(`[mcp:${this.serverName}] ${msg.error.message ?? 'JSON-RPC error'} (code ${msg.error.code ?? '?'})`));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
