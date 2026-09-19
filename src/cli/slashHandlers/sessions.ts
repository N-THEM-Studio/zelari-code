/**
 * slashHandlers/sessions — `/sessions` (v2.53 interactive picker).
 *
 * v2.53: `/sessions` no longer only prints text. With a picker UI wired
 * (TUI), it opens a fuzzy-filterable SelectList of past sessions; selecting
 * one re-enters the slash pipeline as `/resume <id>`, i.e. the SAME resume
 * path a typed `/resume <id>` uses (sessionKindRouter → current-session
 * marker). The textual list ("--list" surface) is untouched: without a
 * picker the handler delegates to sessionKindRouter('session') exactly as
 * the pre-picker code did, and every headless/scripted caller keeps
 * byte-identical output.
 *
 * Search haystack: [session name, engine/agent label, cwd] joined with
 * spaces, fed to the multi-term AND fuzzy matcher (components/fuzzyMatch.ts).
 * `name` = the session's first user prompt, `engine` = the profile recorded
 * on the spine's `session.started`, `cwd` = that event's workspace — all read
 * best-effort from the 2.0 spine (`<workspace>/.zelari/sessions/<id>/…`), so
 * a session without a spine log still lists (name falls back to the id) and
 * a broken log never breaks the picker.
 */
import path from 'node:path';
import { readSessionLog, resolveSessionsDir } from '@zelari/core/session';
import {
  SESSION_LIST_LIMIT,
  getCurrentSessionId,
  listSessions,
  sessionKindRouter,
  type SessionInfo,
} from '../sessionManager.js';
import { appendSystem } from '../hooks/messageHelpers.js';
import type { ChatMessage } from '../components/ChatStream.js';
import type { OpenPicker, PickerItem } from './provider.js';

export interface SessionsSlashContext {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}

/** The three searchable facets of a session (see the module doc). */
export interface SessionSearchFields {
  /** Human handle: the first user prompt, or '' when the spine has none. */
  name: string;
  /** Engine/agent label: the profile recorded at session start (e.g. 'kraken/v1'). */
  engine: string;
  /** Workspace root the session ran in ('' when unknown). */
  cwd: string;
}

/** Test seams (defaults are the real listing + spine reader). */
export interface SessionsPickerDeps {
  listSessions?: () => Promise<SessionInfo[]>;
  searchFields?: (id: string) => Promise<SessionSearchFields>;
}

const EMPTY_FIELDS: SessionSearchFields = { name: '', engine: '', cwd: '' };

/** [name, engine, cwd] joined for the fuzzy matcher (empties dropped). */
export function sessionSearchText(fields: SessionSearchFields): string {
  return [fields.name, fields.engine, fields.cwd]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join(' ');
}

/** Collapse a prompt to one short line (labels/haystacks stay compact). */
function oneLine(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Shorten a path for the hint column (keeps the tail, which is the signal). */
function shortenPath(p: string, max = 28): string {
  const flat = p.replace(/\\/g, '/');
  if (flat.length <= max) return flat;
  return `…${flat.slice(flat.length - max + 1)}`;
}

/**
 * Best-effort spine read for one session id. Never throws: a missing spine
 * log / unreadable dir degrades to empty fields (the picker still lists the
 * session, searchable by id).
 */
export async function readSessionSearchFields(
  id: string,
  sessionsDir: string = resolveSessionsDir(),
): Promise<SessionSearchFields> {
  try {
    const report = await readSessionLog(path.join(sessionsDir, id, 'events.jsonl'));
    const started = report.events.find((e) => e.kind === 'session.started');
    const firstUser = report.events.find((e) => e.kind === 'user.message');
    const data = (started?.data ?? {}) as { profile?: unknown; workspace?: unknown };
    const userData = (firstUser?.data ?? {}) as { text?: unknown };
    const name = typeof userData.text === 'string' ? oneLine(userData.text) : '';
    return {
      ...EMPTY_FIELDS,
      name,
      engine: typeof data.profile === 'string' ? data.profile : '',
      cwd: typeof data.workspace === 'string' ? data.workspace : '',
    };
  } catch {
    return { ...EMPTY_FIELDS };
  }
}

/**
 * Pure item builder (exported for tests): one picker row per session, with
 * the fuzzy haystack attached. `current` marks the active session so the
 * cursor and the ✓ land on the session you are in.
 */
export function buildSessionPickerItems(
  sessions: readonly SessionInfo[],
  fields: (id: string) => SessionSearchFields | undefined,
  currentId: string | null = getCurrentSessionId(),
): PickerItem[] {
  return sessions.map((s) => {
    const meta = fields(s.id) ?? EMPTY_FIELDS;
    const dt = new Date(s.mtimeMs).toISOString().replace('T', ' ').slice(0, 16);
    const haystack = sessionSearchText(meta) || s.id;
    const hint = [meta.engine, meta.cwd ? shortenPath(meta.cwd) : '']
      .filter((x) => x.length > 0)
      .join(' · ');
    return {
      value: s.id,
      label: `${s.id.slice(0, 8)}…  ${s.eventCount} events  ${dt}`,
      ...(hint ? { hint } : {}),
      ...(s.id === currentId ? { current: true } : {}),
      searchText: haystack === s.id ? haystack : `${haystack} ${s.id}`,
    };
  });
}

/**
 * `/sessions` — interactive fuzzy picker when the caller has a picker UI,
 * the unchanged textual list otherwise. Selecting re-enters the slash
 * pipeline as `/resume <id>` (same resume path as typing it).
 */
export async function handleSessionsPicker(
  ctx: SessionsSlashContext,
  openPicker?: OpenPicker,
  deps: SessionsPickerDeps = {},
): Promise<void> {
  if (!openPicker) {
    // No picker UI (headless, scripts, tests): the pre-v2.53 textual path,
    // message and all — sessionKindRouter owns the wording and the errors.
    const { message } = await sessionKindRouter('session');
    appendSystem(ctx.setMessages, message);
    return;
  }
  const readFields = deps.searchFields ?? readSessionSearchFields;
  let sessions: SessionInfo[];
  try {
    sessions = await (deps.listSessions ?? listSessions)();
  } catch (err) {
    appendSystem(
      ctx.setMessages,
      `[sessions] error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (sessions.length === 0) {
    appendSystem(ctx.setMessages, '[sessions] no past sessions');
    return;
  }
  // Same cap as the textual list (SESSION_LIST_LIMIT — no new limit invented
  // here); an empty query therefore shows exactly what `--list` would print.
  const shown = sessions.slice(0, SESSION_LIST_LIMIT);
  const meta = new Map<string, SessionSearchFields>();
  for (const s of shown) meta.set(s.id, await readFields(s.id));
  const items = buildSessionPickerItems(shown, (id) => meta.get(id));
  openPicker({
    kind: 'session',
    title: `Resume session — ${items.length} of ${sessions.length}`,
    items,
    commandPrefix: '/resume',
  });
}
