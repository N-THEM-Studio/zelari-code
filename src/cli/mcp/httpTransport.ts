/**
 * httpTransport — MCP Streamable HTTP transport (no SDK, on purpose).
 *
 * Speaks the Streamable HTTP transport used by editor-embedded MCP servers
 * such as the Unreal Engine 5.8+ editor server: one POST per JSON-RPC
 * message, `Mcp-Session-Id` header, responses as plain JSON or as an
 * SSE stream. Node's global fetch + a line-oriented SSE parser are enough
 * for the CLI protocol slice (P5: no heavy deps).
 *
 * Session-loss recovery: a 404 on a session-bound POST clears the session,
 * re-runs the client handshake (via `onSessionLost`) and replays the
 * original message once — an editor restart mid-session self-heals on the
 * next call, because a stateless POST that reaches the new editor process
 * returns 404 for the stale session id.
 *
 * @see https://modelcontextprotocol.io/specification (Streamable HTTP)
 */

export interface McpHttpTransportOptions {
  serverName: string;
  /** Full endpoint URL, e.g. http://127.0.0.1:8000/mcp */
  url: string;
  /** Every JSON-RPC message parsed from server responses. */
  onMessage: (msg: unknown) => void;
  /** Re-run the MCP initialize handshake; awaited before replaying after 404. */
  onSessionLost: () => Promise<void>;
  /** Extra headers (e.g. Authorization). */
  headers?: Record<string, string>;
}

export interface OutgoingMessage {
  /** Present for requests, absent for notifications. */
  id?: number;
  method: string;
  params?: unknown;
}

const SSE_DATA_RE = /^data:\s?(.*)$/;
/** Abort grace: the client-side pending timer must fire first so the user
 *  sees the proper "timed out after Xms" error, not an abort exception. */
const ABORT_GRACE_MS = 250;

export class McpHttpTransport {
  private sessionId: string | null = null;
  private closed = false;
  private reinit: Promise<void> | null = null;
  private readonly controllers = new Set<AbortController>();

  constructor(private readonly opts: McpHttpTransportOptions) {}

  get hasSession(): boolean {
    return this.sessionId !== null;
  }

  /**
   * Deliver one JSON-RPC message. Resolves once the response (if any) has
   * been fed to onMessage. Transport-level failures are converted into
   * JSON-RPC error responses so the client's pending map rejects cleanly
   * through the same pump used for stdio.
   */
  async send(msg: OutgoingMessage, timeoutMs: number): Promise<void> {
    if (this.closed) throw new Error(`[mcp:${this.opts.serverName}] transport closed`);
    try {
      await this.post(msg, timeoutMs, false);
    } catch (err) {
      if (msg.id !== undefined) {
        this.opts.onMessage({
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: -32000,
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
  }

  /** Best-effort session teardown (HTTP DELETE), then abort in-flight POSTs. */
  close(): void {
    this.closed = true;
    for (const ac of this.controllers) ac.abort();
    this.controllers.clear();
    const sid = this.sessionId;
    this.sessionId = null;
    if (!sid) return;
    const headers: Record<string, string> = {
      ...(this.opts.headers ?? {}),
      "mcp-session-id": sid,
    };
    void fetch(this.opts.url, { method: "DELETE", headers }).catch(() => {
      /* best-effort — server may already be gone */
    });
  }

  // ── internals ────────────────────────────────────────────────────────

  private async post(
    msg: OutgoingMessage,
    timeoutMs: number,
    replayed: boolean,
  ): Promise<void> {
    const ac = new AbortController();
    this.controllers.add(ac);
    const timer = setTimeout(() => ac.abort(), timeoutMs + ABORT_GRACE_MS);
    const hadSession = this.sessionId !== null;
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.opts.headers ?? {}),
      };
      if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
      const res = await fetch(this.opts.url, {
        method: "POST",
        headers,
        signal: ac.signal,
        body: JSON.stringify({ jsonrpc: "2.0", ...msg }),
      });
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;

      if (res.status === 404 && hadSession && !replayed && msg.id !== undefined) {
        // Session expired (server restarted): re-handshake, then replay once.
        this.sessionId = null;
        await this.ensureSession();
        return this.post(msg, timeoutMs, true);
      }
      if (!res.ok && res.status !== 202) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
      }
      if (msg.id === undefined) {
        // Notification accepted (202) — no response body expected.
        await res.body?.cancel();
        return;
      }
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        await this.readSse(res);
      } else {
        const body = await res.text();
        if (body) this.opts.onMessage(JSON.parse(body));
      }
    } finally {
      clearTimeout(timer);
      this.controllers.delete(ac);
    }
  }

  /** Dedupe concurrent session-loss recoveries into one handshake. */
  private async ensureSession(): Promise<void> {
    if (!this.reinit) {
      this.reinit = this.opts
        .onSessionLost()
        .finally(() => {
          this.reinit = null;
        })
        .catch(() => {
          /* handshake failure surfaces on the replayed request */
        });
    }
    await this.reinit;
  }

  /** Minimal SSE reader: dispatch complete `data:` events to onMessage. */
  private async readSse(res: Response): Promise<void> {
    const reader = res.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buf = "";
    let data = "";
    const dispatch = () => {
      const payload = data.trim();
      data = "";
      if (!payload) return;
      try {
        this.opts.onMessage(JSON.parse(payload));
      } catch {
        // Malformed frame — skip, the request timer still guards liveness.
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line === "") {
          dispatch(); // blank line = end of event
          continue;
        }
        const m = SSE_DATA_RE.exec(line);
        if (m) data += (data ? "\n" : "") + m[1]!;
      }
    }
    dispatch(); // stream closed mid-event — flush what we have
  }
}
