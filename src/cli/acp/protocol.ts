/**
 * acp/protocol — the ACP subset served by `zelari-code acp`.
 *
 * Agent Client Protocol front door for editors (Zed and any client that
 * speaks ACP): JSON-RPC 2.0 over stdio, framed LSP-style (see framing.ts).
 * Implemented by hand — ZERO new dependencies (P5).
 *
 * ---------------------------------------------------------------------------
 * INBOUND (client -> agent)
 *   initialize         request   { protocolVersion?: number }
 *                                -> { protocolVersion, agentCapabilities, authMethods }
 *   session/new        request   { cwd: string, mcpServers?: unknown[] }
 *                                -> { sessionId }
 *   session/prompt     request   { sessionId, prompt: ContentBlock[] }
 *                                -> { stopReason } (resolved when the turn ends;
 *                                   the JSON-RPC loop is NOT blocked meanwhile)
 *   session/cancel     request   { sessionId } -> null
 *                      notification { sessionId } (accepted both ways: the spec
 *                      has it as a notification, a request is answered with null)
 *   initialized        notification (ignored by design)
 *   $/… or anything else -> -32601. Unknown notification -> logged, no response.
 *
 * OUTBOUND (agent -> client), all `session/update` NOTIFICATIONS:
 *   { sessionId, update: { sessionUpdate: 'agent_message_chunk',
 *                          content: { type: 'text', text } } }
 *   { sessionId, update: { sessionUpdate: 'tool_call',
 *                          callId, title, kind: 'execute', status } }
 *   { sessionId, update: { sessionUpdate: 'tool_call_update', callId, status } }
 *   status is 'pending' | 'in_progress' | 'completed' | 'failed'.
 *
 * Errors: -32700 parse, -32600 invalid request, -32601 method not found,
 * -32602 invalid params, -32603 internal error (the process stays alive).
 *
 * ---------------------------------------------------------------------------
 * DELIBERATELY OUT OF SCOPE (this is a coherent, stable subset — not full
 * spec fidelity; the missing pieces are named here so nobody guesses):
 *   - agent -> client REVERSE requests (session/request_permission,
 *     fs/read_text_file, fs/write_text_file, terminal/*). The agent runs its
 *     own tools through the CLI policy/permission stack instead; ACP clients
 *     therefore never get a permission prompt to answer.
 *   - session/load + session/resume (`loadSession: false` is advertised),
 *     session modes, session models, auth flows (`authMethods: []`).
 *   - client-supplied MCP servers (session/new.mcpServers) are accepted off
 *     the wire and IGNORED — project/user `.zelari/mcp.json` stays the only
 *     MCP source, same as every other CLI surface.
 *   - content blocks other than text (image, audio, resource) are skipped.
 *   - true mid-turn cancellation: `session/cancel` resolves the pending
 *     prompt with stopReason 'cancelled' and drops further updates for that
 *     turn, but the in-process headless turn itself is not force-killed
 *     (dispatchHeadlessTurn exposes no abort seam). Bounded by the CLI's own
 *     turn/tool budgets.
 */

/** ACP protocol version this agent implements (echoed back on initialize). */
export const ACP_PROTOCOL_VERSION = 1;

/** JSON-RPC 2.0 error codes used by this server. */
export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/** Typed JSON-RPC error, mapped 1:1 onto the wire by the server loop. */
export class AcpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'AcpError';
  }
}

/** -32602 factory — malformed/absent params for a known method. */
export function invalidParams(message: string): AcpError {
  return new AcpError(JSON_RPC_ERRORS.INVALID_PARAMS, message);
}

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export type ParsedMessage =
  | { kind: 'request'; request: JsonRpcRequest }
  | { kind: 'notification'; notification: JsonRpcNotification }
  | { kind: 'invalid'; id: JsonRpcId; reason: string };

/**
 * Classify one decoded frame as request / notification / invalid.
 * `jsonrpc` is validated only when present (lenient boot: a client that
 * omits the field is still understood); `method` must be a non-empty string.
 */
export function parseJsonRpcMessage(raw: unknown): ParsedMessage {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { kind: 'invalid', id: null, reason: 'message must be a JSON object' };
  }
  const msg = raw as Record<string, unknown>;
  if (msg['jsonrpc'] !== undefined && msg['jsonrpc'] !== '2.0') {
    return { kind: 'invalid', id: readId(msg['id']), reason: 'jsonrpc must be "2.0"' };
  }
  const method = msg['method'];
  if (typeof method !== 'string' || method.length === 0) {
    return { kind: 'invalid', id: readId(msg['id']), reason: 'method must be a non-empty string' };
  }
  const id = msg['id'];
  if (id === undefined || typeof id === 'string' || typeof id === 'number' || id === null) {
    return id === undefined
      ? {
          kind: 'notification',
          notification: { jsonrpc: '2.0', method, ...(paramsOf(msg) as object) },
        }
      : { kind: 'request', request: { jsonrpc: '2.0', id, method, ...(paramsOf(msg) as object) } };
  }
  return { kind: 'invalid', id: null, reason: 'id must be a string, a number or null' };
}

function paramsOf(msg: Record<string, unknown>): { params?: unknown } {
  return msg['params'] === undefined ? {} : { params: msg['params'] };
}

function readId(raw: unknown): JsonRpcId {
  return typeof raw === 'string' || typeof raw === 'number' ? raw : null;
}

function asObject(params: unknown): Record<string, unknown> {
  return typeof params === 'object' && params !== null && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

/** `initialize` params — protocolVersion is optional (defaults to ours). */
export function readInitializeParams(params: unknown): { protocolVersion: number } {
  const p = asObject(params);
  const version = p['protocolVersion'];
  if (version === undefined) return { protocolVersion: ACP_PROTOCOL_VERSION };
  if (typeof version !== 'number' || !Number.isFinite(version)) {
    throw invalidParams('initialize.protocolVersion must be a number');
  }
  return { protocolVersion: version };
}

/**
 * `session/new` params — `cwd` is required by the spec; `fallbackCwd` (the
 * CLI `--cwd` flag) covers clients that omit it. `mcpServers` is accepted
 * and ignored (see the module header).
 */
export function readSessionNewParams(params: unknown, fallbackCwd?: string): { cwd: string } {
  const p = asObject(params);
  const cwd = p['cwd'];
  if (typeof cwd === 'string' && cwd.trim().length > 0) return { cwd: cwd.trim() };
  if (typeof fallbackCwd === 'string' && fallbackCwd.trim().length > 0) {
    return { cwd: fallbackCwd.trim() };
  }
  throw invalidParams('session/new requires a non-empty `cwd`');
}

/** `session/prompt` params — text blocks are concatenated, others skipped. */
export function readPromptParams(params: unknown): { sessionId: string; text: string } {
  const p = asObject(params);
  const sessionId = p['sessionId'];
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw invalidParams('session/prompt requires a `sessionId`');
  }
  const prompt = p['prompt'];
  if (!Array.isArray(prompt)) {
    throw invalidParams('session/prompt requires a `prompt` content-block array');
  }
  const parts: string[] = [];
  for (const block of prompt) {
    const b = asObject(block);
    if (b['type'] === 'text' && typeof b['text'] === 'string') parts.push(b['text']);
  }
  const text = parts.join('');
  if (text.trim().length === 0) {
    throw invalidParams('session/prompt requires at least one non-empty text block');
  }
  return { sessionId, text };
}

/** Shared reader for the session-scoped methods (cancel). */
export function readSessionIdParams(params: unknown, method: string): { sessionId: string } {
  const p = asObject(params);
  const sessionId = p['sessionId'];
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw invalidParams(`${method} requires a \`sessionId\``);
  }
  return { sessionId };
}

// ---------------------------------------------------------------------------
// Outbound session/update subset
// ---------------------------------------------------------------------------

export type StopReason = 'end_turn' | 'max_tokens' | 'refusal' | 'cancelled';
export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface AgentMessageChunkUpdate {
  sessionUpdate: 'agent_message_chunk';
  content: { type: 'text'; text: string };
}

export interface ToolCallStartUpdate {
  sessionUpdate: 'tool_call';
  callId: string;
  title: string;
  kind: 'execute';
  status: ToolCallStatus;
}

export interface ToolCallStatusUpdate {
  sessionUpdate: 'tool_call_update';
  callId: string;
  status: ToolCallStatus;
}

export type SessionUpdate =
  | AgentMessageChunkUpdate
  | ToolCallStartUpdate
  | ToolCallStatusUpdate;

export function agentMessageChunk(text: string): AgentMessageChunkUpdate {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } };
}

export function toolCallStart(input: {
  callId: string;
  title: string;
  status?: ToolCallStatus;
}): ToolCallStartUpdate {
  return {
    sessionUpdate: 'tool_call',
    callId: input.callId,
    title: input.title,
    kind: 'execute',
    status: input.status ?? 'pending',
  };
}

export function toolCallStatus(input: {
  callId: string;
  status: ToolCallStatus;
}): ToolCallStatusUpdate {
  return { sessionUpdate: 'tool_call_update', callId: input.callId, status: input.status };
}

/** Wrap one update into the `session/update` notification the client expects. */
export function sessionUpdateNotification(
  sessionId: string,
  update: SessionUpdate,
): { jsonrpc: '2.0'; method: 'session/update'; params: { sessionId: string; update: SessionUpdate } } {
  return { jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } };
}
