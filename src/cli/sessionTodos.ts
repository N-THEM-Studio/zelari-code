/**
 * Session-scoped todo list for the single-agent loop (OpenCode-style todowrite).
 * In-process only — reset on /clear|/new. Not the same as `.zelari/plan.json`
 * workspace tasks (those are multi-session durable plans).
 *
 * Per harness session in `--serve-harness` (sessionScope): each Desktop chat
 * sends its own todos with every turn, and concurrent chats must never see
 * (or overwrite) each other's list. Process-wide in the TUI.
 *
 * @since v1.21.0
 */
import { sessionLocal } from './sessionScope.js';

export type SessionTodoStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export interface SessionTodo {
  id: string;
  content: string;
  status: SessionTodoStatus;
}

const store = sessionLocal<SessionTodo[]>(() => []);

export function listSessionTodos(): SessionTodo[] {
  return store.get().map((t) => ({ ...t }));
}

export function clearSessionTodos(): void {
  store.set([]);
}

/** A todo_write item: `content` may be omitted only to patch an existing id (merge). */
export interface SessionTodoInput {
  id?: string;
  content?: string;
  status?: SessionTodoStatus;
}

/**
 * Ids of merge patches that cannot be applied: no `content` and no existing
 * todo with that id (a status-only patch needs something to patch).
 */
export function unresolvedTodoPatches(items: readonly SessionTodoInput[]): string[] {
  const known = new Set(store.get().map((t) => t.id));
  return items
    .filter((it) => !it.content?.trim())
    .map((it) => it.id?.trim() ?? '')
    .filter((id) => !id || !known.has(id))
    .map((id) => id || '(no id)');
}

/**
 * Replace or merge todos. Items with matching ids update; new ids append.
 * When `merge` is false (default), the list becomes exactly `items` (after
 * normalization; items without content are dropped). When true, only listed
 * ids are upserted, others kept; an omitted `content`/`status` keeps the
 * existing value (status-only patch), and id-less new items get a fresh `tN`
 * id that never collides with an existing todo.
 */
export function writeSessionTodos(
  items: SessionTodoInput[],
  opts?: { merge?: boolean },
): SessionTodo[] {
  const merge = opts?.merge === true;

  if (!merge) {
    const next = items
      .map((it, i) => ({
        id: (it.id?.trim() || `t${i + 1}`).slice(0, 64),
        content: (it.content ?? '').trim().slice(0, 500),
        status: it.status ?? 'pending',
      }))
      .filter((t) => t.content.length > 0)
      .slice(0, 40);
    store.set(next);
    return listSessionTodos();
  }

  const byId = new Map(store.get().map((t) => [t.id, t]));
  let next = 1;
  const freshId = (): string => {
    while (byId.has(`t${next}`)) next++;
    return `t${next}`;
  };
  for (const it of items) {
    const id = (it.id?.trim() || freshId()).slice(0, 64);
    const existing = byId.get(id);
    const content = (it.content?.trim() || existing?.content || '').slice(0, 500);
    if (!content) continue;
    byId.set(id, { id, content, status: it.status ?? existing?.status ?? 'pending' });
  }
  store.set([...byId.values()].slice(0, 40));
  return listSessionTodos();
}

export function formatTodosForModel(list: readonly SessionTodo[] = store.get()): string {
  if (list.length === 0) return '(no todos)';
  return list
    .map((t) => {
      const mark =
        t.status === 'completed'
          ? 'x'
          : t.status === 'in_progress'
            ? '>'
            : t.status === 'cancelled'
              ? '-'
              : ' ';
      return `- [${mark}] ${t.id}: ${t.content} (${t.status})`;
    })
    .join('\n');
}

/** One-line summary for StatusBar / Desktop chip: "todos 2/5" or null if empty. */
export function formatTodoStatusSummary(
  list: readonly SessionTodo[] = store.get(),
): string | null {
  if (list.length === 0) return null;
  const done = list.filter(
    (t) => t.status === 'completed' || t.status === 'cancelled',
  ).length;
  const active = list.filter((t) => t.status === 'in_progress').length;
  const base = `todos ${done}/${list.length}`;
  return active > 0 ? `${base} · ${active} active` : base;
}

/** Test helper. */
export function _resetSessionTodosForTests(): void {
  store.set([]);
}
