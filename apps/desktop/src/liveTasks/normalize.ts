import type { DesktopTodo } from "../sessionTodosUi";
import type { LiveTask, LiveTaskStatus } from "./types";

/** Convert parsed session todos into the unified live-task model. */
export function toSessionTasks(todos: DesktopTodo[]): LiveTask[] {
  return todos.map((t) => ({
    id: t.id,
    content: t.content,
    status: t.status as LiveTaskStatus,
    source: "session" as const,
  }));
}

/** Upsert `incoming` onto `prev` by id (todo_write merge=true). */
export function mergeSessionTasks(
  prev: LiveTask[],
  incoming: LiveTask[],
): LiveTask[] {
  const out = [...prev];
  for (const t of incoming) {
    const i = out.findIndex((x) => x.id === t.id);
    if (i >= 0) out[i] = t;
    else out.push(t);
  }
  return out;
}

/** Payload replayed to the CLI on the next runTask (`RunTaskArgs.todos`). */
export function toTodoPayload(
  tasks: LiveTask[],
): Array<{ id: string; content: string; status: string }> {
  return tasks.map(({ id, content, status }) => ({ id, content, status }));
}

/** Defensive normalize for tasks loaded from localStorage. */
export function sanitizeTasks(value: unknown): LiveTask[] {
  if (!Array.isArray(value)) return [];
  const out: LiveTask[] = [];
  for (const v of value as Array<Record<string, unknown>>) {
    if (!v || typeof v.content !== "string" || !v.content.trim()) continue;
    const s = v.status;
    out.push({
      id: typeof v.id === "string" && v.id ? v.id : `t${out.length + 1}`,
      content: v.content.slice(0, 500),
      status:
        s === "in_progress" || s === "completed" || s === "cancelled" ||
        s === "blocked"
          ? s
          : "pending",
      source: v.source === "project" ? "project" : "session",
    });
  }
  return out;
}
