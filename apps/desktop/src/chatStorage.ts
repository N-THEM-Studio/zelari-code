/**
 * Local chat persistence for Zelari Desktop (localStorage only).
 */
import type { Conversation } from "./types";

const KEY = "zelari-desktop-chats-v1";

export function loadConversations(): Conversation[] | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Conversation[];
    if (!Array.isArray(parsed)) return null;
    return parsed.map(normalizeConv);
  } catch {
    return null;
  }
}

export function saveConversations(conversations: Conversation[]): void {
  try {
    // Cap storage: keep last 80 conversations
    const capped = conversations.slice(0, 80).map((c) => ({
      ...c,
      // Cap message bodies to avoid huge localStorage
      messages: c.messages.slice(-200),
    }));
    localStorage.setItem(KEY, JSON.stringify(capped));
  } catch {
    /* quota — ignore */
  }
}

function normalizeConv(c: Conversation): Conversation {
  return {
    ...c,
    mode: c.mode === "council" || c.mode === "zelari" ? c.mode : "agent",
    phase: c.phase === "plan" ? "plan" : "build",
    messages: Array.isArray(c.messages) ? c.messages : [],
    archived: !!c.archived,
  };
}
