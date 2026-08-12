/**
 * permissionBroker — socket broker for external-agent permission prompts.
 *
 * Pattern ported from OpenMausBot (`server/permission-proxy.ts`, MIT): an
 * external CLI agent (e.g. `claude --permission-prompt-tool`) spawns
 * `zelari-code --permission-mcp <socket>` as a child MCP stdio server; that
 * child forwards `approve` / `ask_user` requests to THIS broker (the parent
 * zelari-code TUI/headless process) over a local socket, and the human
 * decision flows back.
 *
 * Transport: JSON-lines over `node:net` — unix socket on POSIX, named pipe
 * on Windows (same API). Zero new dependencies.
 *
 * Wire protocol (broker side):
 *   client → broker: {"t":"ask","id":"<uuid>","kind":"permission"|"question", ...}
 *   broker → client: {"t":"answer","id":"<uuid>","behavior":"allow"|"deny","message"?,"always"?,"answer"?}
 *
 * If no handler is registered (or the handler throws), the broker answers
 * `deny` — the agent must never hang waiting on a broken approval channel.
 *
 * @since v1.30.0
 */

import { connect, createServer, type Server, type Socket } from "node:net";
import { unlink } from "node:fs";

export const PERMISSION_BROKER_DEFAULT_TIMEOUT_MS = 60_000;
export const PERMISSION_BROKER_DEFAULT_CONNECT_TIMEOUT_MS = 2_000;

// ── Types shared by broker and MCP server ──────────────────────────────────

export interface BrokerPermissionRequest {
  id: string;
  tool: string;
  input: unknown;
  toolUseId?: string;
  suggestions?: unknown[];
}

export interface BrokerQuestionRequest {
  id: string;
  question: string;
  choices?: string[];
  context?: string;
}

export type BrokerPermissionAnswer = {
  behavior: "allow" | "deny";
  message?: string;
  /** True when the human chose "always this session" (informational). */
  always?: boolean;
};

export type BrokerQuestionAnswer = {
  behavior: "allow" | "deny";
  answer?: string;
  message?: string;
};

export interface PermissionBrokerHandlers {
  onPermission?: (req: BrokerPermissionRequest) => Promise<BrokerPermissionAnswer>;
  onQuestion?: (req: BrokerQuestionRequest) => Promise<BrokerQuestionAnswer | null>;
}

export interface PermissionBrokerHandle {
  readonly socketPath: string;
  stop: () => Promise<void>;
}

/** Result of a single ask round-trip, as seen by the MCP server client. */
export interface BrokerAskResult {
  behavior: "allow" | "deny";
  message?: string;
  always?: boolean;
  answer?: string;
}

/** Ask message the MCP server sends over the socket. */
export interface BrokerAskMessage {
  t: "ask";
  id: string;
  kind: "permission" | "question";
  tool?: string;
  input?: unknown;
  toolUseId?: string;
  suggestions?: unknown[];
  question?: string;
  choices?: string[];
  context?: string;
}

function sendJson(socket: Socket, obj: unknown): void {
  if (socket.destroyed) return;
  socket.write(JSON.stringify(obj) + "\n");
}

function safeSocketPath(socketPath: string): string {
  return socketPath.trim();
}

/**
 * Start the broker listener on `socketPath`. Resolves once listening.
 *
 * Each connection is treated as a stream of `ask` messages; every request
 * gets exactly one `answer` (handler result, handler absence, error, or a
 * per-request timeout — never nothing).
 */
export function startPermissionBroker(
  socketPath: string,
  handlers: PermissionBrokerHandlers,
  opts?: { requestTimeoutMs?: number },
): Promise<PermissionBrokerHandle> {
  const path = safeSocketPath(socketPath);
  const requestTimeoutMs =
    opts?.requestTimeoutMs ?? PERMISSION_BROKER_DEFAULT_TIMEOUT_MS;
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    socket.setEncoding("utf8");
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {
      // Client vanished mid-request — nothing to answer.
    });
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        void handleLine(socket, line);
      }
    });
  });
  server.on("error", () => {
    // Post-listen errors (e.g. client reset) are non-fatal.
  });

  async function handleLine(socket: Socket, line: string): Promise<void> {
    let msg: BrokerAskMessage;
    try {
      msg = JSON.parse(line) as BrokerAskMessage;
    } catch {
      return; // ignore non-JSON noise
    }
    if (!msg || msg.t !== "ask" || typeof msg.id !== "string" || !msg.id) return;

    const id = msg.id;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const reply = (answer: BrokerAskResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      sendJson(socket, { t: "answer", id, ...answer });
    };

    timer = setTimeout(() => {
      reply({
        behavior: "deny",
        message: `[zelari] permission broker timed out after ${requestTimeoutMs}ms`,
      });
    }, requestTimeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    try {
      if (msg.kind === "question") {
        if (!handlers.onQuestion) {
          reply({
            behavior: "deny",
            message:
              "[zelari] no interactive answer available (question handler missing)",
          });
          return;
        }
        const answer = await handlers.onQuestion({
          id,
          question: msg.question ?? "",
          choices: msg.choices,
          context: msg.context,
        });
        if (answer == null) {
          reply({
            behavior: "deny",
            message: "[zelari] question cancelled (no answer)",
          });
          return;
        }
        if (answer.behavior === "deny") {
          reply({
            behavior: "deny",
            message:
              answer.message ?? "[zelari] question denied by handler",
          });
          return;
        }
        reply({ behavior: "allow", answer: answer.answer ?? "" });
        return;
      }
      // kind === "permission"
      const answer = handlers.onPermission
        ? await handlers.onPermission({
            id,
            tool: msg.tool ?? "unknown",
            input: msg.input,
            toolUseId: msg.toolUseId,
            suggestions: msg.suggestions,
          })
        : {
            behavior: "deny" as const,
            message: "[zelari] permission broker has no approval handler",
          };
      reply(answer);
    } catch (err) {
      reply({
        behavior: "deny",
        message: `[zelari] permission broker error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  }

  return new Promise<PermissionBrokerHandle>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(path, () => {
      server.removeListener("error", onError);
      resolve({
        socketPath: path,
        stop: () =>
          new Promise<void>((res) => {
            for (const s of sockets) s.destroy();
            sockets.clear();
            // Windows named pipes: server.close() waits for every accepted
            // connection to end — closeAllConnections() forces that so stop()
            // never hangs on a stale client handle.
            const closeAll = (
              server as unknown as { closeAllConnections?: () => void }
            ).closeAllConnections;
            if (typeof closeAll === "function") closeAll.call(server);
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              if (process.platform !== "win32") {
                unlink(path, () => res());
              } else {
                res();
              }
            };
            server.close(() => finish());
            // Safety net: never let stop() hang (e.g. platform quirks).
            setTimeout(finish, 1_000).unref?.();
          }),
      });
    });
  });
}

/**
 * Send one `ask` over the wire and await the matching `answer`.
 *
 * Used by the MCP stdio server (`--permission-mcp`) to reach the broker in
 * the parent zelari process. Rejects (never hangs) when:
 *   - the socket cannot be reached within `connectTimeoutMs`,
 *   - the broker closes the connection without answering,
 *   - no answer arrives within `requestTimeoutMs`.
 */
export function requestBrokerAsk(
  socketPath: string,
  ask: BrokerAskMessage,
  opts?: {
    requestTimeoutMs?: number;
    connectTimeoutMs?: number;
  },
): Promise<BrokerAskResult> {
  const path = safeSocketPath(socketPath);
  const requestTimeoutMs =
    opts?.requestTimeoutMs ?? PERMISSION_BROKER_DEFAULT_TIMEOUT_MS;
  const connectTimeoutMs =
    opts?.connectTimeoutMs ?? PERMISSION_BROKER_DEFAULT_CONNECT_TIMEOUT_MS;

  return new Promise<BrokerAskResult>((resolve, reject) => {
    const socket = connect(path);
    let buffer = "";
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(requestTimer);
      socket.destroy();
      fn();
    };

    const connectTimer = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            `permission broker unavailable at "${path}" (connect timed out after ${connectTimeoutMs}ms)`,
          ),
        ),
      );
    }, connectTimeoutMs);
    const requestTimer = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            `permission broker timed out after ${requestTimeoutMs}ms waiting for an answer`,
          ),
        ),
      );
    }, requestTimeoutMs);

    socket.setEncoding("utf8");
    socket.on("connect", () => clearTimeout(connectTimer));
    socket.on("error", (err) => settle(() => reject(err)));
    socket.on("close", () => {
      settle(() =>
        reject(new Error("permission broker closed the connection without an answer")),
      );
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg: { t?: string; id?: string };
        try {
          msg = JSON.parse(line) as { t?: string; id?: string };
        } catch {
          continue; // ignore non-JSON noise
        }
        if (msg?.t === "answer" && msg.id === ask.id) {
          // Strip transport fields (t, id) — the caller wants the answer only.
          const { t: _t, id: _id, ...answer } = msg;
          settle(() => resolve(answer as BrokerAskResult));
          return;
        }
      }
    });

    sendJson(socket, ask);
  });
}
