import { useCallback, useState } from "react";
import { formatDesktopTodoSummary } from "../sessionTodosUi";

const LS_COLLAPSED = "zelari-desktop-session-tasks-collapsed";

interface Props {
  /** Structurally widened: renders both DesktopTodo and LiveTask rows. */
  todos: Array<{ id: string; content: string; status: string }>;
  onClear?: () => void;
}

export function SessionTodosPanel({ todos, onClear }: Props) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LS_COLLAPSED) === "1";
    } catch {
      return false;
    }
  });

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(LS_COLLAPSED, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  if (!todos.length) return null;
  const summary = formatDesktopTodoSummary(todos);

  return (
    <div
      className={`session-todos-panel${collapsed ? " collapsed" : ""}`}
      aria-label="Session todos"
    >
      <div className="session-todos-head">
        <button
          type="button"
          className="session-todos-toggle"
          onClick={toggle}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand tasks" : "Collapse tasks"}
        >
          <span className="session-todos-chevron" aria-hidden>
            {collapsed ? "▸" : "▾"}
          </span>
          <span className="session-todos-title">Tasks</span>
        </button>
        {summary ? (
          <span className="session-todos-summary">{summary}</span>
        ) : null}
        {onClear ? (
          <button
            type="button"
            className="btn-ghost session-todos-clear"
            onClick={onClear}
          >
            Clear
          </button>
        ) : null}
      </div>
      {collapsed ? null : (
        <ul className="session-todos-list">
          {todos.map((t) => (
            <li key={t.id} className={`session-todo status-${t.status}`}>
              <span className="session-todo-mark" aria-hidden>
                {t.status === "completed"
                  ? "✓"
                  : t.status === "in_progress"
                    ? "▶"
                    : t.status === "cancelled"
                      ? "–"
                      : "○"}
              </span>
              <span className="session-todo-text">{t.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
