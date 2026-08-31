/**
 * mcpClient — minimal Model Context Protocol client (stdio + Streamable HTTP).
 *
 * Implements exactly the slice of MCP the CLI needs to consume external
 * tool servers: `initialize` handshake, `tools/list` discovery (with
 * cursor pagination), and `tools/call` execution.
 *
 * Two transports behind one JSON-RPC pump:
 *  - stdio  (default): newline-delimited JSON-RPC 2.0 over a child process
 *  - http   (config `type: "http"` / `url`): Streamable HTTP — used by
 *    editor-embedded servers such as the Unreal Engine 5.8+ editor server
 *    (loopback, `Mcp-Session-Id`, JSON or SSE responses, 404 → re-handshake)
 *
 * No SDK dependency on purpose: the protocol slice stays ~250 lines and the
 * official SDK would be the CLI's heaviest dependency by far.
 *
 * @see https://modelcontextprotocol.io/specification
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { buildCmdLine } from "../utils/cmdline.js";
import { getCurrentVersion } from "../updater.js";
import { McpHttpTransport } from "./httpTransport.js";

/** JSON-RPC id → pending resolver. */
interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export type McpTransportType = "stdio" | "http";

export interface McpServerConfig {
  /** Executable for stdio servers (e.g. 'npx', 'node', 'uvx'). Optional
   *  when `url` is set (http servers run inside another process, e.g. the
   *  UE 5.8+ editor). */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Set false to keep the entry in config but skip it. */
  enabled?: boolean;
  /** Transport selection. Defaults: 'http' when only `url` is set, else 'stdio'. */
  type?: McpTransportType;
  /** Streamable HTTP endpoint (e.g. http://127.0.0.1:8000/mcp). */
  url?: string;
  /** Per-server request timeout in ms (default 30000). Editor servers with
   *  slow tools (asset scans, builds) should raise this. */
  timeoutMs?: number;
  /** Serialize requests to this server. Default: true for http (editor
   *  servers must not receive overlapping calls on the game thread),
   *  false for stdio. */
  serial?: boolean;
}

export interface McpToolInfo {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments (as provided by the server). */
  inputSchema: Record<string, unknown>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const INIT_TIMEOUT_MS = 15_000;
/** Guard against a broken server paginating forever. */
const MAX_LIST_PAGES = 50;
export const MCP_PROTOCOL_VERSION = "2025-03-26";

export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private transport: McpHttpTransport | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stdoutBuffer = "";
  private closed = false;
  /** Tail of the serial queue (config.serial); requests run one at a time. */
  private queueTail: Promise<unknown> = Promise.resolve();
  /** True while the 404-recovery handshake runs: bypasses the serial queue
   *  (the queued request that triggered the 404 is waiting on this handshake). */
  private recovering = false;
  private readonly serial: boolean;
  private readonly defaultTimeoutMs: number;

  constructor(
    public readonly serverName: string,
    private readonly config: McpServerConfig,
  ) {
    this.defaultTimeoutMs = config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.serial = config.serial ?? this.transportKind() === "http";
  }

  private transportKind(): McpTransportType {
    if (this.config.type) return this.config.type;
    return this.config.url && !this.config.command ? "http" : "stdio";
  }

  /** Connect (spawn / HTTP session) and run the MCP initialize handshake. */
  async start(): Promise<void> {
    if (this.child || this.transport) return;
    if (this.transportKind() === "http") {
      const url = this.config.url;
      if (!url) {
        throw new Error(`[mcp:${this.serverName}] http server requires a url`);
      }
      this.transport = new McpHttpTransport({
        serverName: this.serverName,
        url,
        // env may carry an explicit Authorization header for remote servers.
        headers: this.config.env?.AUTHORIZATION
          ? { Authorization: this.config.env.AUTHORIZATION }
          : undefined,
        onMessage: (msg) => this.handleMessage(msg),
        onSessionLost: () => this.handshake(),
      });
      await this.handshake();
      return;
    }
    const command = this.config.command;
    if (!command) {
      throw new Error(`[mcp:${this.serverName}] stdio server requires a command`);
    }
    const spawnOpts = {
      stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(this.config.env ?? {}) },
      windowsHide: true,
    };
    // On Windows `npx`/`uvx` resolve to .cmd shims which plain spawn cannot
    // execute, so a shell is required — but passing an args ARRAY together
    // with shell:true is deprecated (DEP0190: args concatenated unescaped).
    // Build the command line ourselves with explicit quoting instead.
    const child = (
      process.platform === "win32"
        ? spawn(buildCmdLine(command, this.config.args ?? []), {
            ...spawnOpts,
            shell: true,
          })
        : spawn(command, this.config.args ?? [], spawnOpts)
    ) as ChildProcessWithoutNullStreams;
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.on("error", (err) =>
      this.failAll(
        new Error(`[mcp:${this.serverName}] spawn failed: ${err.message}`),
      ),
    );
    child.on("exit", (code) => {
      if (!this.closed) {
        this.failAll(
          new Error(
            `[mcp:${this.serverName}] server exited (code ${code ?? "null"})`,
          ),
        );
      }
    });

    await this.handshake();
  }

  private async handshake(): Promise<void> {
    const prev = this.recovering;
    this.recovering = true;
    try {
      await this.request(
        "initialize",
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "zelari-code", version: getCurrentVersion() },
        },
        INIT_TIMEOUT_MS,
      );
      this.notify("notifications/initialized", {});
    } finally {
      this.recovering = prev;
    }
  }

  /**
   * Discover the server's tools. Follows `nextCursor` pagination so
   * large servers (hundreds of tools) are listed completely.
   */
  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const res = (await this.request(
        "tools/list",
        cursor ? { cursor } : {},
      )) as {
        tools?: Array<{
          name?: string;
          description?: string;
          inputSchema?: Record<string, unknown>;
        }>;
        nextCursor?: string;
      };
      for (const t of res.tools ?? []) {
        if (!t.name) continue;
        tools.push({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        });
      }
      cursor = typeof res.nextCursor === "string" ? res.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  /**
   * Call a tool. Returns the concatenated text content; non-text content
   * items are summarized by type. Throws when the server flags isError.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<string> {
    const res = (await this.request(
      "tools/call",
      { name, arguments: args },
      timeoutMs ?? this.defaultTimeoutMs,
    )) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const text = (res.content ?? [])
      .map((c) =>
        c.type === "text" && typeof c.text === "string"
          ? c.text
          : `[${c.type ?? "unknown"} content]`,
      )
      .join("\n");
    if (res.isError)
      throw new Error(text || `tool "${name}" reported an error`);
    return text;
  }

  /** Terminate the server / session and reject all in-flight requests. */
  close(): void {
    this.closed = true;
    this.failAll(new Error(`[mcp:${this.serverName}] client closed`));
    if (this.transport) {
      this.transport.close();
      this.transport = null;
      return;
    }
    this.child?.kill();
    this.child = null;
  }

  // ── JSON-RPC plumbing (shared by both transports) ────────────────────

  private request(
    method: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    const effective = timeoutMs ?? this.defaultTimeoutMs;
    // Recovery handshakes bypass the queue: the queued request that hit the
    // 404 is parked waiting for this handshake to finish.
    if (!this.serial || this.recovering)
      return this.dispatch(method, params, effective);
    // Serial mode (http default): one request in flight per server. The
    // tail swallows rejections so a failure never blocks the queue.
    const run = this.queueTail.then(
      () => this.dispatch(method, params, effective),
      () => this.dispatch(method, params, effective),
    );
    this.queueTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private dispatch(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const transport = this.transport;
    const child = this.child;
    if (!transport && !child)
      return Promise.reject(new Error(`[mcp:${this.serverName}] not started`));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `[mcp:${this.serverName}] ${method} timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (transport) {
        // Transport-level failures come back as JSON-RPC error messages.
        void transport.send({ id, method, params }, timeoutMs);
      } else {
        const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
        child!.stdin.write(payload + "\n", (err) => {
          if (err) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(err);
          }
        });
      }
    });
  }

  private notify(method: string, params: unknown): void {
    if (this.transport) {
      void this.transport.send({ method, params }, this.defaultTimeoutMs);
      return;
    }
    this.child?.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
    );
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let nl: number;
    while ((nl = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, nl).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (!line) continue;
      try {
        this.handleMessage(JSON.parse(line));
      } catch {
        continue; // servers sometimes log garbage to stdout — ignore non-JSON
      }
    }
  }

  /** Route one parsed JSON-RPC message to its pending request (both transports). */
  private handleMessage(msg: unknown): void {
    const m = msg as {
      id?: number;
      result?: unknown;
      error?: { message?: string; code?: number };
    };
    if (typeof m.id !== "number") return; // server notification — none handled
    const pending = this.pending.get(m.id);
    if (!pending) return; // already timed out / closed — ignore
    this.pending.delete(m.id);
    clearTimeout(pending.timer);
    if (m.error) {
      pending.reject(
        new Error(
          `[mcp:${this.serverName}] ${m.error.message ?? "JSON-RPC error"} (code ${m.error.code ?? "?"})`,
        ),
      );
    } else {
      pending.resolve(m.result);
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
