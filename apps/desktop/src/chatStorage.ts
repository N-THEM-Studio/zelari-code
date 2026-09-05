/**
 * Local chat persistence for Zelari Desktop (localStorage only).
 *
 * Storage policy (explicit, not positional): when the conversation list
 * exceeds MAX_STORED_CONVERSATIONS the MOST RECENTLY UPDATED conversations
 * survive, and the ACTIVE conversation is always guaranteed a slot — a chat
 * the user just created or opened must never be silently evicted because of
 * where it happens to sit in the array. Relative order is preserved so the
 * sidebar order survives reloads. Quota failures are reported to the caller
 * (SaveResult), never swallowed.
 */
import type { Conversation } from "./types";
import { sanitizeTasks } from "./liveTasks/normalize";

const KEY = "zelari-desktop-chats-v1";
/** Legacy global folder key (pre per-conversation cwd). App keeps it as
 * the "last opened workspace" default; here it is only a migration source. */
const LEGACY_WORKDIR_KEY = "zelari-desktop-workdir";

export const MAX_STORED_CONVERSATIONS = 80;
export const MAX_MESSAGES_PER_CONVERSATION = 200;

export interface StorageSelectionOpts {
  /** Conversation that must survive the cap even when least recently updated. */
  activeId?: string;
  /** Override for tests. */
  limit?: number;
}

/**
 * Pure selection: pick which conversations persist under the cap.
 * - keeps the `limit` most recently updated conversations (updatedAt desc,
 *   deterministic tie-break: later array position wins);
 * - guarantees the active conversation a slot (evicting the least recent
 *   kept entry if needed);
 * - preserves the input's relative order; NEVER mutates the input.
 */
export function selectConversationsForStorage(
  conversations: Conversation[],
  opts: StorageSelectionOpts = {},
): Conversation[] {
  const limit = Math.max(1, opts.limit ?? MAX_STORED_CONVERSATIONS);
  if (conversations.length <= limit) {
    return conversations.slice();
  }
  const ranked = conversations
    .map((c, idx) => ({ c, idx }))
    .sort((a, b) => b.c.updatedAt - a.c.updatedAt || b.idx - a.idx);
  const kept = new Set(ranked.slice(0, limit).map(({ c }) => c.id));
  const active =
    opts.activeId != null
      ? conversations.find((c) => c.id === opts.activeId)
      : undefined;
  if (active && !kept.has(active.id)) {
    // Evict the least recent kept entry to guarantee the active chat a slot.
    kept.delete(ranked[limit - 1]!.c.id);
    kept.add(active.id);
  }
  return conversations.filter((c) => kept.has(c.id));
}

/** Outcome of a save: on failure `error` explains why (e.g. quota) and the
 * previous storage content is left untouched. */
export interface SaveResult {
  ok: boolean;
  /** Conversations actually written to storage. */
  stored: number;
  /** Conversations not persisted (cap eviction, or all of them on failure). */
  dropped: number;
  /** Present only when ok === false. */
  error?: string;
}

export function loadConversations(): Conversation[] | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    // Legacy migration: the old app had ONE global folder - stamp it on
    // every conversation that lacks its own cwd.
    const legacyCwd = localStorage.getItem(LEGACY_WORKDIR_KEY) || null;
    return parsed
      .filter((c): c is Conversation => !!c && typeof c === "object")
      .map((c) => normalizeConv(c, legacyCwd));
  } catch {
    return null;
  }
}

export function saveConversations(
  conversations: Conversation[],
  opts: StorageSelectionOpts = {},
): SaveResult {
  const selected = selectConversationsForStorage(conversations, opts);
  const capped = selected.map((c) => ({
    ...c,
    // Cap message bodies to avoid huge localStorage (keep the TAIL = latest).
    messages: c.messages.slice(-MAX_MESSAGES_PER_CONVERSATION),
  }));
  try {
    localStorage.setItem(KEY, JSON.stringify(capped));
    return {
      ok: true,
      stored: capped.length,
      dropped: conversations.length - capped.length,
    };
  } catch (e) {
    return {
      ok: false,
      stored: 0,
      dropped: conversations.length,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function normalizeConv(
  c: Conversation,
  legacyCwd: string | null,
): Conversation {
  return {
    ...c,
    mode: c.mode === "council" || c.mode === "zelari" ? c.mode : "kraken",
    phase: c.phase === "plan" ? "plan" : "build",
    messages: Array.isArray(c.messages) ? c.messages : [],
    archived: !!c.archived,
    cwd:
      typeof c.cwd === "string" && c.cwd.trim()
        ? c.cwd
        : legacyCwd ?? undefined,
    sessionTasks: sanitizeTasks(c.sessionTasks),
    // Backward-compatible: legacy chats without the field normalize to [].
    pendingFollowUps: Array.isArray(c.pendingFollowUps)
      ? c.pendingFollowUps.filter((s): s is string => typeof s === "string")
      : [],
  };
}
