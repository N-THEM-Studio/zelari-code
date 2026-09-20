/**
 * protocol — the ACP subset `zelari-code acp` actually implements.
 *
 * This mirrors src/cli/acp/protocol.ts (the server's single source of truth);
 * it is a transcription of what the server does, NOT a wish list. The
 * extension must never invent protocol: everything below is exercised by
 * scripts/smoke-acp.mjs and src/cli/acp/*.test.ts.
 *
 * ---------------------------------------------------------------------------
 * INBOUND (this client -> agent), JSON-RPC 2.0 over NDJSON stdio:
 *   initialize      { protocolVersion? }
 *                   -> { protocolVersion, agentCapabilities, authMethods }
 *   session/new     { cwd? }                       -> { sessionId }
 *   session/prompt  { sessionId, prompt: ContentBlock[] }
 *                   -> { stopReason } when the turn ends (the loop is not
 *                      blocked meanwhile: notifications stream during it)
 *   session/cancel  { sessionId }                  -> null
 *   initialized     notification (handshake tail; ignored by the server)
 *
 * OUTBOUND (agent -> this client), all `session/update` notifications:
 *   { sessionId, update: { sessionUpdate: 'agent_message_chunk',
 *                          content: { type: 'text', text }, truncated? } }
 *   { sessionId, update: { sessionUpdate: 'tool_call', callId, title,
 *                          kind: 'execute', status } }
 *   { sessionId, update: { sessionUpdate: 'tool_call_update', callId, status } }
 *   status is 'pending' | 'in_progress' | 'completed' | 'failed'.
 *
 * ---------------------------------------------------------------------------
 * DELIBERATELY UNUSED (out of scope on the server too — see its header):
 * reverse requests (session/request_permission, fs/*, terminal/*), so no
 * permission UI here; session/load + resume; session modes/models; auth;
 * client-supplied MCP servers; non-text content blocks. The CLI runs its own
 * permission/policy stack for its own tools.
 */

/** ACP protocol version this client speaks (echoed by the server on initialize). */
export const ACP_PROTOCOL_VERSION = 1;

/** Methods the server implements — the ONLY ones this client may call. */
export const ACP_METHODS = {
  initialize: 'initialize',
  sessionNew: 'session/new',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
} as const;

/** Notifications, in both directions. */
export const ACP_NOTIFICATIONS = {
  /** client -> agent: handshake tail. */
  initialized: 'initialized',
  /** agent -> client: the stream carrier for messages and tool calls. */
  sessionUpdate: 'session/update',
} as const;

export type StopReason = 'end_turn' | 'max_tokens' | 'refusal' | 'cancelled';

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface AgentMessageChunkUpdate {
  sessionUpdate: 'agent_message_chunk';
  content: { type: 'text'; text: string };
  /**
   * True iff the agent clamped `text` to its payload cap. The server never
   * truncates silently (invariant 2), so this flag is the honest signal the
   * UI must surface instead of pretending the message was complete.
   */
  truncated?: true;
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

/** `session/update` params (the notification payload). */
export interface AcpSessionUpdateParams {
  sessionId: string;
  update: SessionUpdate;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: { loadSession?: boolean; promptCapabilities?: unknown };
  authMethods?: unknown[];
}

export interface AcpPromptResult {
  stopReason: StopReason;
}

export interface AcpNewSessionResult {
  sessionId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Wire guard for `session/update` (the payload is untrusted: it comes from a pipe). */
export function isSessionUpdateParams(value: unknown): value is AcpSessionUpdateParams {
  if (!isRecord(value)) return false;
  if (typeof value['sessionId'] !== 'string' || value['sessionId'].length === 0) return false;
  return isSessionUpdate(value['update']);
}

export function isSessionUpdate(value: unknown): value is SessionUpdate {
  if (!isRecord(value)) return false;
  switch (value['sessionUpdate']) {
    case 'agent_message_chunk': {
      const content = value['content'];
      return isRecord(content) && content['type'] === 'text' && typeof content['text'] === 'string';
    }
    case 'tool_call':
      return typeof value['callId'] === 'string' && typeof value['title'] === 'string';
    case 'tool_call_update':
      return typeof value['callId'] === 'string' && typeof value['status'] === 'string';
    default:
      return false;
  }
}

const MAX_LINE_CHARS = 200;

/** Collapse to one line and cap it: an OutputChannel line, not a transcript dump. */
function oneLine(text: string, cap: number = MAX_LINE_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= cap ? flat : `${flat.slice(0, cap)}…`;
}

/**
 * One human-readable line for the tool-call / message stream. PURE, so the
 * visible behaviour of the extension's OutputChannel is unit-tested without
 * a VS Code host. ASCII prefixes on purpose (Windows consoles, log greps).
 */
export function describeUpdate(update: SessionUpdate): string {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const truncated = update.truncated === true ? ' [truncated by agent]' : '';
      return `text> ${oneLine(update.content.text)}${truncated}`;
    }
    case 'tool_call':
      return `tool> ${oneLine(update.title, 80)} [${update.status}] (${update.callId})`;
    case 'tool_call_update':
      return `tool> ${update.callId} -> ${update.status}`;
  }
}
