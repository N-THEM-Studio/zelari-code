import type { ChatMessage } from '../components/ChatStream.js';

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

/** Append a tool invocation indicator (▶ name(args) or ✓/✗ result). */
export function appendToolStart(
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  toolName: string,
  args: unknown,
  ts: number,
): void {
  const argsPreview = JSON.stringify(args).slice(0, 120);
  appendSystem(setMessages, `▶ ${toolName}(${argsPreview})`, ts);
}

/** Append a tool result indicator. */
export function appendToolEnd(
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  result: string,
  isError: boolean,
  durationMs: number,
  ts: number,
): void {
  const preview = result.slice(0, 200);
  const icon = isError ? '✗' : '✓';
  appendSystem(
    setMessages,
    `${icon} ${preview}${result.length > 200 ? '…' : ''} (${durationMs}ms)`,
    ts,
  );
}

/** Update the matching `tool_execution_start` message with its end status. */
export function updateToolMessageEnd(
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  toolCallId: string,
  isError: boolean,
  durationMs: number,
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
          content: `${m.toolName ?? 'tool'}${isError ? ' → error' : ' → ok'} (${durationMs}ms)`,
        };
        return updated;
      }
    }
    return prev;
  });
}