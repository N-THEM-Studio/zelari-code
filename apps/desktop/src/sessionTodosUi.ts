/**
 * Parse session todo tool results from headless agent events (Desktop).
 * CLI keeps todos in-process; Desktop only sees tool result strings.
 */

export type DesktopTodoStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled";

export interface DesktopTodo {
  id: string;
  content: string;
  status: DesktopTodoStatus;
}

export function parseTodoToolResult(result: string | undefined | null): DesktopTodo[] | null {
  if (!result || typeof result !== "string") return null;
  const text = result.trim();
  if (!text) return null;

  // Prefer JSON blob (registry may stringify { todos, formatted })
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const obj = JSON.parse(text.slice(start, end + 1)) as {
        todos?: Array<{ id?: string; content?: string; status?: string }>;
      };
      if (Array.isArray(obj.todos)) {
        return obj.todos
          .filter((t) => t && typeof t.content === "string")
          .map((t, i) => ({
            id: String(t.id ?? `t${i + 1}`),
            content: String(t.content).slice(0, 500),
            status: normalizeStatus(t.status),
          }));
      }
    }
  } catch {
    /* fall through to line parse */
  }

  // Markdown-ish: - [x] id: content (status)
  const lines = text.split("\n");
  const out: DesktopTodo[] = [];
  for (const line of lines) {
    const m = /^[-*]\s*\[([xX>\-\s])\]\s*(?:(\S+):\s*)?(.+?)(?:\s*\((\w+)\))?\s*$/.exec(
      line.trim(),
    );
    if (!m) continue;
    const mark = m[1];
    const id = m[2] ?? `t${out.length + 1}`;
    const content = m[3]?.trim() ?? "";
    let status = normalizeStatus(m[4]);
    if (mark === "x" || mark === "X") status = "completed";
    else if (mark === ">") status = "in_progress";
    else if (mark === "-") status = "cancelled";
    if (content) out.push({ id, content, status });
  }
  return out.length ? out : null;
}

function normalizeStatus(s: string | undefined): DesktopTodoStatus {
  const v = (s ?? "pending").toLowerCase();
  if (
    v === "pending" ||
    v === "in_progress" ||
    v === "completed" ||
    v === "cancelled"
  ) {
    return v;
  }
  return "pending";
}

export function formatDesktopTodoSummary(todos: DesktopTodo[]): string | null {
  if (!todos.length) return null;
  const done = todos.filter(
    (t) => t.status === "completed" || t.status === "cancelled",
  ).length;
  const active = todos.filter((t) => t.status === "in_progress").length;
  const base = `todos ${done}/${todos.length}`;
  return active > 0 ? `${base} · ${active} active` : base;
}
