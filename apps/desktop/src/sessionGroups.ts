/**
 * Session sidebar grouping: chats bucketed by their project folder (cwd),
 * rendered as collapsible sections. Pure logic + localStorage persistence
 * so the App component stays thin and the grouping is unit-testable.
 */
import { normalizeCwdKey } from "./liveTasks/workspacePlan";

export const SESSION_FOLDERS_STORAGE_KEY = "zelari-desktop-session-folders";

/** Bucket key for chats without a bound working directory. */
export const NO_FOLDER_KEY = "__no_folder__";

export interface SessionLike {
  id: string;
  cwd?: string;
  updatedAt: number;
}

export interface SessionGroup<T extends SessionLike> {
  key: string;
  label: string;
  path: string;
  sessions: T[];
}

/** Last path segment of a cwd → human folder label ("Z:\a\b\my-app" → "my-app"). */
export function folderLabelFromCwd(cwd: string | undefined): string {
  if (!cwd || !cwd.trim()) return "No folder";
  const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : "No folder";
}

/** Canonical group key: same normalization as run-registry routing (M2). */
export function sessionGroupKey(cwd: string | undefined): string {
  if (!cwd || !cwd.trim()) return NO_FOLDER_KEY;
  return normalizeCwdKey(cwd);
}

/**
 * Group sessions by cwd, most-recent-first inside each group, groups sorted
 * by their latest session activity. "No folder" always sinks to the bottom.
 */
export function groupSessionsByFolder<T extends SessionLike>(
  sessions: T[],
): SessionGroup<T>[] {
  const map = new Map<string, SessionGroup<T>>();
  for (const s of sessions) {
    const key = sessionGroupKey(s.cwd);
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        label: folderLabelFromCwd(s.cwd),
        path: s.cwd?.trim() ?? "",
        sessions: [],
      };
      map.set(key, g);
    }
    g.sessions.push(s);
  }
  const groups = [...map.values()];
  for (const g of groups) {
    g.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  groups.sort((a, b) => {
    if (a.key === NO_FOLDER_KEY && b.key !== NO_FOLDER_KEY) return 1;
    if (b.key === NO_FOLDER_KEY && a.key !== NO_FOLDER_KEY) return -1;
    const aLatest = a.sessions[0]?.updatedAt ?? 0;
    const bLatest = b.sessions[0]?.updatedAt ?? 0;
    return bLatest - aLatest;
  });
  return groups;
}

/** Load the persisted set of collapsed group keys (tolerant of junk). */
export function loadCollapsedSet(storageKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

export function persistCollapsedSet(
  storageKey: string,
  keys: Set<string>,
): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify([...keys]));
  } catch {
    /* quota / private mode — collapse state just won't persist */
  }
}

export function toggleCollapsedKey(
  prev: Set<string>,
  key: string,
): Set<string> {
  const next = new Set(prev);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
