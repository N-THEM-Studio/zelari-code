import { formatDesktopTodoSummary } from "../sessionTodosUi";

interface Props {
  /** Structurally widened: renders both DesktopTodo and LiveTask rows. */
  todos: Array<{ id: string; content: string; status: string }>;
  onClear?: () => void;
}

/**
 * Session todos block of the unified tasks card. Purely presentational:
 * LiveTasksPanel owns the collapse button and the card chrome, this renders
 * just the "Sessione" section (title + summary + rows + Clear).
 */
export function SessionTodosPanel({ todos, onClear }: Props) {
  if (!todos.length) return null;
  const summary = formatDesktopTodoSummary(todos);

  return (
    <section className="live-tasks-section" aria-label="Session tasks">
      <div className="session-todos-head">
        <span className="session-todos-title">Sessione</span>
        {summary ? <span className="session-todos-summary">{summary}</span> : null}
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
    </section>
  );
}
