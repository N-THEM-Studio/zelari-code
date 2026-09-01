/**
 * Folder-switch semantics (P0): picking a new workspace folder must NEVER
 * rebind the cwd of a conversation that already carries context — doing so
 * contaminated the old project's spine session and history with the new
 * folder (cross-project context bleed). Pure + unit-testable; App.tsx only
 * wires the returned plan into state.
 */
import type { Conversation } from "./types";

export interface FolderSwitchPlan {
  /** Next conversation list (a new array; the input is never mutated). */
  conversations: Conversation[];
  /** Conversation that should be active after the switch. */
  nextActiveId: string;
  /** True when the active chat was virgin and was rebound in place. */
  reboundInPlace: boolean;
}

/**
 * A conversation is "virgin" when it holds no real exchange yet: no spine
 * sessionId and no user/assistant messages. System/tool noise from a dead
 * run does not count as context worth protecting.
 */
export function isVirginConversation(c: Conversation): boolean {
  if (typeof c.sessionId === "string" && c.sessionId.trim()) return false;
  return !c.messages.some((m) => m.role === "user" || m.role === "assistant");
}

let switchSeq = 0;

/**
 * Plan the state transition for a folder pick:
 * - virgin active chat → same list, its cwd rebound to `newCwd`, activeId
 *   unchanged (keeps the old "fresh chat, pick folder first" flow);
 * - otherwise → the active chat KEEPS its old cwd and a NEW conversation
 *   bound to `newCwd` is appended; nextActiveId points at the new chat.
 *   The new chat carries no sessionId, so the first send() in the new
 *   folder starts a fresh spine there.
 */
export function planFolderSwitch(
  conversations: Conversation[],
  activeId: string,
  newCwd: string,
  opts: { now?: number; newId?: string } = {},
): FolderSwitchPlan {
  const active = conversations.find((c) => c.id === activeId);
  // Unknown active (should not happen): nothing safe to rebind — keep as is.
  if (!active) {
    return { conversations, nextActiveId: activeId, reboundInPlace: false };
  }
  if (isVirginConversation(active)) {
    return {
      conversations: conversations.map((c) =>
        c.id === activeId ? { ...c, cwd: newCwd } : c,
      ),
      nextActiveId: activeId,
      reboundInPlace: true,
    };
  }
  const now = opts.now ?? Date.now();
  const fresh: Conversation = {
    id: opts.newId ?? `conv-${now.toString(36)}-${(++switchSeq).toString(36)}sw`,
    title: "New chat",
    messages: [],
    createdAt: now,
    updatedAt: now,
    mode: active.mode,
    phase: active.phase,
    provider: active.provider,
    model: active.model,
    cwd: newCwd || undefined,
    archived: false,
  };
  return {
    conversations: [...conversations, fresh],
    nextActiveId: fresh.id,
    reboundInPlace: false,
  };
}
