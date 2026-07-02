import type { ChatMessage } from '../components/ChatStream.js';
import { formatToolSummary } from '../components/toolFormat.js';

/**
 * Helpers for building ChatMessage instances in the most common shapes.
 *
 * Extracted from app.tsx (Task v0.4.2 audit split). The previous code
 * constructed these inline 50+ times with the same shape:
 *   setMessages((prev) => [
 *     ...prev,
 *     { id: crypto.randomUUID(), role: 'system', content: '...', ts: Date.now() },
 *   ]);
 *
 * The `appendX(setMessages, content)` wrappers are kept functional so they
 * play nicely with the React state setter signature.
 */

/** Append a system message at the end of the chat. */
export function appendSystem(
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  content: string,
  ts: number = Date.now(),
): void {
  setMessages((prev) => [
    ...prev,
    { id: crypto.randomUUID(), role: 'system', content, ts },
  ]);
}

/** Append a user message (the user's submitted prompt). */
export function appendUser(
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  content: string,
  ts: number = Date.now(),
): void {
  setMessages((prev) => [
    ...prev,
    { id: crypto.randomUUID(), role: 'user', content, ts },
  ]);
}

/**
 * Append or extend the streaming assistant message. If the last message is
 * already a streaming assistant message, append `delta` to its content;
 * otherwise create a new one with a stable streaming id.
 *
 * When `memberName` is set (council-sourced messages), it's stamped on
 * the message so the visible-reasoning UI can render `🜂 Caronte: …`
 * headers above the streamed text.
 */
export function appendOrExtendStreamingAssistant(
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  fullContent: string,
  ts: number,
  memberContext?: { memberId?: string; memberName?: string },
): void {
  setMessages((prev) => {
    const last = prev[prev.length - 1];
    if (last && last.role === 'assistant' && last.id.startsWith('streaming-')) {
      return [...prev.slice(0, -1), { ...last, content: fullContent }];
    }
    return [
      ...prev,
      {
        id: `streaming-${crypto.randomUUID()}`,
        role: 'assistant',
        content: fullContent,
        ts,
        ...(memberContext?.memberId ? { memberId: memberContext.memberId } : {}),
        ...(memberContext?.memberName ? { memberName: memberContext.memberName } : {}),
      },
    ];
  });
}

/**
 * Max chars of tool result kept for the body. v0.7.3: raised 600 → 8000 to
 * match chatState.ts — the 600-char cut chopped the JSON envelope before
 * formatToolResult could parse it, forcing the raw-escaped fallback.
 */
export const TOOL_RESULT_PREVIEW_CHARS = 8000;

/** Max chars of the JSON args preview shown on the tool summary line. */
export const TOOL_ARGS_PREVIEW_CHARS = 120;

/**
 * Append a tool invocation as a `role: 'tool'` message so ChatStream renders
 * it via the live region's tool rendering (one status line per invocation, updated in
 * place by {@link updateToolMessageEnd}) instead of loose system lines.
 */
export function appendToolStart(
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  toolName: string,
  toolCallId: string,
  args: unknown,
  ts: number,
): void {
  // v0.7.1 (B2): human-readable summary instead of raw-JSON args (which cut
  // mid-string like {"path":"…","content":"Scrivi una spiegazione estrema…").
  const argsPreview = formatToolSummary(toolName, args);
  setMessages((prev) => [
    ...prev,
    {
      id: crypto.randomUUID(),
      role: 'tool',
      content: argsPreview,
      ts,
      toolName,
      toolCallId,
      toolOk: undefined,
      toolDurationMs: undefined,
    },
  ]);
}

/**
 * Update the matching `tool_execution_start` message with its end status.
 * The summary (args preview) is kept; the result is stored separately as the
 * expandable body. Failed invocations auto-expand in ChatStream.
 */
export function updateToolMessageEnd(
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  toolCallId: string,
  isError: boolean,
  durationMs: number,
  result?: string,
): void {
  setMessages((prev) => {
    for (let i = prev.length - 1; i >= 0; i--) {
      const m = prev[i];
      if (m && m.role === 'tool' && m.toolCallId === toolCallId && m.toolDurationMs === undefined) {
        const updated = [...prev];
        updated[i] = {
          ...m,
          toolOk: !isError,
          toolDurationMs: durationMs,
          ...(result !== undefined
            ? {
                toolResult:
                  result.length > TOOL_RESULT_PREVIEW_CHARS
                    ? `${result.slice(0, TOOL_RESULT_PREVIEW_CHARS)}…`
                    : result,
              }
            : {}),
        };
        return updated;
      }
    }
    return prev;
  });
}

/**
 * Seal the trailing streaming assistant message (if any) by dropping its
 * `streaming-` id prefix. Called on `message_end` so the NEXT assistant
 * message in the same turn (e.g. after a tool call) starts a fresh bubble
 * instead of being merged into — or duplicated over — the previous one.
 */
export function finalizeStreamingAssistant(
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
): void {
  setMessages((prev) => {
    const last = prev[prev.length - 1];
    if (last && last.role === 'assistant' && last.id.startsWith('streaming-')) {
      return [...prev.slice(0, -1), { ...last, id: last.id.slice('streaming-'.length) }];
    }
    return prev;
  });
}