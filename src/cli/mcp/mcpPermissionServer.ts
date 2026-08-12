/**
 * mcpPermissionServer — MCP stdio server for external-agent approval
 * (OpenMausBot `server/permission-proxy.ts` pattern, MIT).
 *
 * Spawned by an external CLI via `zelari-code --permission-mcp <socket>`.
 * Speaks newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio
 * transport) and forwards `approve` / `ask_user` tool calls to the broker
 * socket owned by the parent zelari process.
 *
 * Exposes exactly the slice `src/cli/mcp/mcpClient.ts` drives:
 *   - `initialize` handshake
 *   - `tools/list` discovery
 *   - `tools/call` execution
 *
 * Contract:
 *   - stdout carries ONLY JSON-RPC responses (never console.log);
 *     diagnostics go to stderr.
 *   - broker unreachable / timeout / missing handler → tool result with
 *     `{"behavior":"deny","message":"…unavailable"}` — the agent must never
 *     hang on a broken approval channel.
 *
 * `input`/`output` are injectable for tests (default process.stdin/stdout).
 *
 * @since v1.30.0
 */

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { getCurrentVersion } from "../updater.js";
import {
  PERMISSION_BROKER_DEFAULT_TIMEOUT_MS,
  requestBrokerAsk,
} from "./permissionBroker.js";

export const PERMISSION_MCP_PROTOCOL_VERSION = "2025-03-26";

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const APPROVE_TOOL: McpTool = {
  name: "approve",
  description:
    "Ask the human to approve or deny a tool call from an external agent. " +
    "Returns JSON {behavior: 'allow'|'deny', updatedInput?, updatedPermissions?}.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string", description: "Name of the tool the agent wants to run" },
      input: { type: "object", description: "Arguments the agent wants to pass" },
      tool_use_id: { type: "string", description: "Agent-side tool use id (echoed back)" },
      permission_suggestions: {
        type: "array",
        items: { type: "object" },
        description:
          "Permission rules the CLI suggests; returned as updatedPermissions only when the user allows permanently",
      },
      suggestions: {
        type: "array",
        items: { type: "object" },
        description: "Alias of permission_suggestions (accepted for compat)",
      },
    },
    required: ["tool_name", "input"],
  },
};

const ASK_USER_TOOL: McpTool = {
  name: "ask_user",
  description:
    "Ask the human a structured question. Returns JSON {answer: '<text>'} " +
    "or {behavior: 'deny', message} if cancelled/unavailable.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "One focused question" },
      choices: {
        type: "array",
        items: { type: "string" },
        description: "2–6 concrete options; the human may still type a free answer",
      },
      context: { type: "string", description: "Why this choice matters (one short line)" },
    },
    required: ["question"],
  },
};

export const PERMISSION_MCP_TOOLS: readonly McpTool[] = [
  APPROVE_TOOL,
  ASK_USER_TOOL,
];

export interface PermissionMcpServerOptions {
  socketPath: string;
  input?: Readable;
  output?: Writable;
  requestTimeoutMs?: number;
}

export interface PermissionMcpServerHandle {
  /** Resolves when the input stream ends (stdin closed by the parent CLI). */
  closed: Promise<void>;
  stop: () => Promise<void>;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * Start the MCP stdio server. Resolves once the readline loop is attached.
 */
export function startPermissionMcpServer(
  opts: PermissionMcpServerOptions,
): Promise<PermissionMcpServerHandle> {
  const socketPath = opts.socketPath.trim();
  const requestTimeoutMs =
    opts.requestTimeoutMs ?? PERMISSION_BROKER_DEFAULT_TIMEOUT_MS;
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  // Never crash on a closed pipe: when the parent CLI exits it may close our
  // stdout/stderr; writes then fail with EPIPE. Swallow stream errors.
  input.on?.("error", () => {});
  output.on?.("error", () => {});

  let closedResolve: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });
  let stopped = false;

  const send = (obj: unknown) => {
    if (stopped || output.destroyed) return;
    output.write(JSON.stringify(obj) + "\n");
  };

  const rl = createInterface({ input, crlfDelay: Infinity });

  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(text) as RpcMessage;
    } catch {
      return; // never echo garbage; real MCP clients send valid JSON
    }
    // Notifications carry no id — nothing to reply.
    if (typeof msg.id === "undefined") return;
    void handleRpc(msg)
      .then((out) => {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          ...((out ?? {}) as Record<string, unknown>),
        });
      })
      .catch((err) => {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: -32603,
            message: `internal error: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
      });
  });
  rl.on("close", () => {
    closedResolve();
  });

  async function handleRpc(msg: RpcMessage): Promise<unknown> {
    const method = msg.method ?? "";

    // Notifications (no id) are filtered by the caller; be safe anyway.
    if (typeof msg.id === "undefined") {
      return { result: null };
    }

    if (method === "initialize") {
      const requested =
        typeof msg.params?.protocolVersion === "string"
          ? msg.params.protocolVersion
          : PERMISSION_MCP_PROTOCOL_VERSION;
      return {
        result: {
          protocolVersion: requested,
          capabilities: { tools: {} },
          serverInfo: {
            name: "zelari-permission-mcp",
            version: getCurrentVersion(),
          },
        },
      };
    }

    if (method === "tools/list") {
      return { result: { tools: PERMISSION_MCP_TOOLS } };
    }

    if (method === "tools/call") {
      const params = msg.params ?? {};
      const name = typeof params.name === "string" ? params.name : "";
      const args =
        params.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {};
      const out =
        name === "approve"
          ? await callApprove(args, requestTimeoutMs)
          : name === "ask_user"
            ? await callAskUser(args, requestTimeoutMs)
            : { error: { code: -32602, message: `unknown tool: ${name}` } };
      // Tool handlers return either `{error}` (protocol error → top-level
      // JSON-RPC error) or a result object.
      if (
        out &&
        typeof out === "object" &&
        "error" in out &&
        (out as { error?: unknown }).error
      ) {
        return { error: (out as { error: unknown }).error };
      }
      return { result: out };
    }

    return { error: { code: -32601, message: `method not found: ${method}` } };
  }

  async function callApprove(
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const toolName = typeof args.tool_name === "string" ? args.tool_name : "";
    if (!toolName) {
      return { error: { code: -32602, message: "approve requires a string tool_name" } };
    }
    const input = args.input ?? {};
    const suggestions = Array.isArray(args.permission_suggestions)
      ? args.permission_suggestions
      : Array.isArray(args.suggestions)
        ? args.suggestions
        : undefined;

    try {
      const res = await requestBrokerAsk(
        socketPath,
        {
          t: "ask",
          id: randomUUID(),
          kind: "permission",
          tool: toolName,
          input,
          toolUseId: typeof args.tool_use_id === "string" ? args.tool_use_id : undefined,
          suggestions,
        },
        { requestTimeoutMs: timeoutMs },
      );
      const result =
        res.behavior === "allow"
          ? {
              behavior: "allow" as const,
              updatedInput: input,
              ...(res.always === true && suggestions && suggestions.length > 0
                ? { updatedPermissions: suggestions }
                : {}),
            }
          : {
              behavior: "deny" as const,
              message:
                res.message ?? "[zelari] permission denied (no reason given)",
            };
      return textResult(JSON.stringify(result));
    } catch (err) {
      return textResult(
        JSON.stringify({
          behavior: "deny",
          message: `[zelari] permission broker unavailable: ${
            err instanceof Error ? err.message : String(err)
          }`,
        }),
      );
    }
  }

  async function callAskUser(
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const question = typeof args.question === "string" ? args.question : "";
    if (!question) {
      return { error: { code: -32602, message: "ask_user requires a string question" } };
    }
    const choices = Array.isArray(args.choices)
      ? args.choices.filter((c): c is string => typeof c === "string")
      : undefined;
    const context = typeof args.context === "string" ? args.context : undefined;

    try {
      const res = await requestBrokerAsk(
        socketPath,
        {
          t: "ask",
          id: randomUUID(),
          kind: "question",
          question,
          choices,
          context,
        },
        { requestTimeoutMs: timeoutMs },
      );
      const text =
        res.behavior === "allow" && typeof res.answer === "string"
          ? res.answer
          : (res.message ?? "No answer was given — use your best judgment.");
      return textResult(text);
    } catch (err) {
      return textResult(
        JSON.stringify({
          behavior: "deny",
          message: `[zelari] permission broker unavailable: ${
            err instanceof Error ? err.message : String(err)
          }`,
        }),
      );
    }
  }

  function textResult(text: string): unknown {
    return {
      content: [{ type: "text", text }],
    };
  }

  return Promise.resolve({
    closed,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      rl.close();
      closedResolve();
    },
  });
}
