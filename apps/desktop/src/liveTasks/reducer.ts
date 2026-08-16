import type { Conversation } from "../types";
import type { LiveTask } from "./types";

/**
 * Immutably set `sessionTasks` on one conversation.
 * No-op (same array reference) when the conversation is missing, so it is
 * safe to call from event listeners that may race a chat deletion.
 */
export function applySessionTasks(
  conversations: Conversation[],
  conversationId: string,
  updater: LiveTask[] | ((prev: LiveTask[]) => LiveTask[]),
): Conversation[] {
  return conversations.map((c) => {
    if (c.id !== conversationId) return c;
    const prev = c.sessionTasks ?? [];
    const next = typeof updater === "function" ? updater(prev) : updater;
    if (next === prev) return c;
    return { ...c, sessionTasks: next, updatedAt: Date.now() };
  });
}

/** Clear the session tasks of one conversation. */
export function clearSessionTasks(
  conversations: Conversation[],
  conversationId: string,
): Conversation[] {
  return conversations.map((c) =>
    c.id === conversationId && (c.sessionTasks?.length ?? 0) > 0
      ? { ...c, sessionTasks: [], updatedAt: Date.now() }
      : c,
  );
}
