/**
 * Session-scoped todo list for the single-agent loop (OpenCode-style todowrite).
 * In-process only — reset on /clear|/new. Not the same as `.zelari/plan.json`
 * workspace tasks (those are multi-session durable plans).
 *
 * @since v1.21.0
 */

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

let todos: SessionTodo[] = [];

export function listSessionTodos(): SessionTodo[] {
  return todos.map((t) => ({ ...t }));
}

export function clearSessionTodos(): void {
  todos = [];
}

/**
 * Replace or merge todos. Items with matching ids update; new ids append.
 * When `merge` is false (default), the list becomes exactly `items` (after
 * normalization). When true, only listed ids are upserted; others kept.
 */
export function writeSessionTodos(
  items: Array<{ id?: string; content: string; status?: SessionTodoStatus }>,
  opts?: { merge?: boolean },
): SessionTodo[] {
  const merge = opts?.merge === true;
  const normalized: SessionTodo[] = items.map((it, i) => ({
    id: (it.id?.trim() || `t${i + 1}`).slice(0, 64),
    content: it.content.trim().slice(0, 500),
    status: it.status ?? 'pending',
  })).filter((t) => t.content.length > 0);

  if (!merge) {
    todos = normalized.slice(0, 40);
    return listSessionTodos();
  }

  const byId = new Map(todos.map((t) => [t.id, t]));
  for (const t of normalized) {
    byId.set(t.id, t);
  }
  todos = [...byId.values()].slice(0, 40);
  return listSessionTodos();
}

export function formatTodosForModel(list: readonly SessionTodo[] = todos): string {
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
  list: readonly SessionTodo[] = todos,
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
  todos = [];
}
