import type { Conversation } from "../types";
import type { LiveTask } from "./types";

/** Session tasks of one conversation (todo_write/todo_read mirror). */
export function selectSessionTasks(
  conversations: Conversation[],
  conversationId: string | undefined | null,
): LiveTask[] {
  if (!conversationId) return [];
  return (
    conversations.find((c) => c.id === conversationId)?.sessionTasks ?? []
  );
}
