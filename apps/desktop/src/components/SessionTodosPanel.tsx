import type { DesktopTodo } from "../sessionTodosUi";
import { formatDesktopTodoSummary } from "../sessionTodosUi";

interface Props {
  todos: DesktopTodo[];
  onClear?: () => void;
}

export function SessionTodosPanel({ todos, onClear }: Props) {
  if (!todos.length) return null;
  const summary = formatDesktopTodoSummary(todos);

  return (
    <div className="session-todos-panel" aria-label="Session todos">
      <div className="session-todos-head">
        <span className="session-todos-title">Tasks</span>
        {summary ? <span className="session-todos-summary">{summary}</span> : null}
        {onClear ? (
          <button type="button" className="btn-ghost session-todos-clear" onClick={onClear}>
            Clear
          </button>
        ) : null}
      </div>
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
    </div>
  );
}
