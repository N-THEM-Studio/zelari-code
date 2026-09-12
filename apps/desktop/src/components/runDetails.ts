/**
 * Run-row details (F4 polish of the global runs dashboard).
 *
 * The pure derivation behind one drawer row: which project folder the run
 * belongs to, which user prompt started it and how long ago it started.
 *
 * Split out of `RunsDashboard.tsx` on purpose: the rules are worth testing
 * without a DOM, and the drawer stays a thin presentational component. No
 * React, no Tauri, no module-level clock — every time helper takes `now`.
 */
import type { ChatMessage, Conversation } from "../types";
import type { RunRuntime } from "../runs/types";

/** Chip label when neither the run nor the chat knows a working directory. */
export const PROJECT_FALLBACK = "app";

/** Honest cell when the conversation has no user message to quote. */
export const PROMPT_FALLBACK = "—";

/** Honest cell for a timestamp that cannot be rendered. */
export const TIME_FALLBACK = "—";

/** Hard cap of the excerpt; the CSS ellipsis clips whatever is left. */
export const PROMPT_EXCERPT_MAX = 120;

/** Last path segment of a cwd ("Z:\a\zelari-code" → "zelari-code"). */
export function projectLabel(cwd: string | undefined): string {
  const parts = (cwd ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .split("/")
    .filter((part) => part.trim().length > 0);
  return parts.length ? parts[parts.length - 1]!.trim() : PROJECT_FALLBACK;
}

/**
 * Working directory of a run: what the run itself reported first (M2 stamps
 * every event with it), the chat's current binding as fallback. "" = unknown,
 * never a guessed path.
 */
export function runCwd(run: RunRuntime, conv: Conversation | undefined): string {
  return run.cwd?.trim() || conv?.cwd?.trim() || "";
}

/** Collapse every whitespace run so the excerpt stays ONE line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The user prompt that started THIS run: the last `role: "user"` message sent
 * no later than `startedAt`, or the first one when the timestamps are missing
 * (a conversation that was resumed/replayed keeps its original prompt).
 * Returns the shared "—" when there is nothing honest to show.
 */
export function promptExcerpt(
  messages: ChatMessage[] | undefined,
  startedAt: number,
  max: number = PROMPT_EXCERPT_MAX,
): string {
  const user = (messages ?? []).filter(
    (m) => m.role === "user" && typeof m.content === "string",
  );
  if (user.length === 0) return PROMPT_FALLBACK;
  const before = user.filter(
    (m) => Number.isFinite(m.createdAt) && m.createdAt <= startedAt,
  );
  // Latest of the eligible prompts, independent of array order.
  const picked = before.length
    ? before.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a))
    : user[0]!;
  const text = oneLine(picked.content);
  if (!text) return PROMPT_FALLBACK;
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
}

/** Absolute HH:mm in the local timezone — the fallback of every relative form. */
export function formatClock(ts: number): string {
  if (!Number.isFinite(ts)) return TIME_FALLBACK;
  const date = new Date(ts);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Built per call: a degraded runtime must fall back, not throw at import. */
function relativeFormatter(locale: string): Intl.RelativeTimeFormat | null {
  try {
    if (typeof Intl.RelativeTimeFormat !== "function") return null;
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  } catch {
    return null;
  }
}

/**
 * "2 min fa" (Intl.RelativeTimeFormat, Italian: the whole UI is Italian).
 * Beyond a week — and whenever the runtime has no relative formatter or the
 * timestamp is unusable — the absolute HH:mm is shown instead.
 */
export function formatRelativeTime(
  ts: number,
  now: number,
  locale = "it",
): string {
  const deltaSeconds = (now - ts) / 1000;
  if (
    !Number.isFinite(ts) ||
    !Number.isFinite(deltaSeconds) ||
    deltaSeconds < 0 // a start in the future is not a duration we can name
  ) {
    return formatClock(ts);
  }
  const rtf = relativeFormatter(locale);
  if (!rtf) return formatClock(ts);
  const seconds = Math.max(0, Math.round(deltaSeconds));
  if (seconds < 45) return rtf.format(0, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 7) return rtf.format(-days, "day");
  return formatClock(ts);
}
