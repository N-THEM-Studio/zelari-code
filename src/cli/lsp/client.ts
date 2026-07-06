/**
 * lsp/client — a minimal JSON-RPC 2.0 client speaking LSP over a transport.
 *
 * The transport is injectable (a language-server child process's stdio in
 * production, a fake in tests), so the request/response correlation, server
 * request handling, and timeouts are all unit-testable without spawning a
 * real language server.
 */

import { encodeMessage, createMessageParser } from './protocol.js';

/** Bidirectional byte transport (framed LSP strings both ways). */
export interface LspTransport {
  /** Write a framed message to the server. */
  send: (data: string) => void;
  /** Register a handler for raw stdout chunks from the server. */
  onData: (cb: (chunk: string) => void) => void;
  /** Register a handler for transport close. */
  onClose: (cb: () => void) => void;
  /** Tear the transport down. */
  dispose: () => void;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: unknown;
}

export interface LspClientOptions {
  /** Per-request timeout in ms (default 15000). */
  timeoutMs?: number;
}

export class LspClient {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private parser = createMessageParser();
  private closed = false;
  private readonly timeoutMs: number;

  constructor(
    private readonly transport: LspTransport,
    options: LspClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    transport.onData((chunk) => this.onData(chunk));
    transport.onClose(() => this.onClose());
  }

  /** Send a request and await the matching response. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('LSP transport is closed'));
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request "${method}" timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.transport.send(encodeMessage(msg));
    });
  }

  /** Fire a notification (no response expected). */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) };
    this.transport.send(encodeMessage(msg));
  }

  private onData(chunk: string): void {
    for (const message of this.parser.push(chunk)) {
      this.handleMessage(message as JsonRpcResponse & JsonRpcRequest);
    }
  }

  private handleMessage(message: JsonRpcResponse & JsonRpcRequest): void {
    // Response to one of our requests (has an id AND result/error, no method).
    if (message.method === undefined && message.id !== undefined) {
      const entry = this.pending.get(message.id as number);
      if (!entry) return;
      this.pending.delete(message.id as number);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new Error(`LSP error ${message.error.code}: ${message.error.message}`));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    // Server → client REQUEST (has method AND id): reply so the server doesn't
    // stall. We don't implement any client capabilities, so a null result is
    // the safe universal answer (e.g. workspace/configuration → null).
    if (message.method !== undefined && message.id !== undefined) {
      this.transport.send(
        encodeMessage({ jsonrpc: '2.0', id: message.id, result: null }),
      );
      return;
    }
    // Server → client NOTIFICATION (method, no id): ignored (diagnostics,
    // logs, progress). The tools use pull-based requests instead.
  }

  private onClose(): void {
    this.closed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('LSP transport closed before response'));
    }
    this.pending.clear();
  }

  dispose(): void {
    this.onClose();
    this.transport.dispose();
  }
}
