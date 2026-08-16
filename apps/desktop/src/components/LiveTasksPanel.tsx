import type { LiveTask } from "../liveTasks/types";
import { SessionTodosPanel } from "./SessionTodosPanel";

interface Props {
  tasks: LiveTask[];
  /** Workspace project tasks of the active cwd (`.zelari/plan.json`). */
  projectTasks?: LiveTask[];
  onClear?: () => void;
}

function projectSummary(tasks: LiveTask[]): string | null {
  if (!tasks.length) return null;
  const done = tasks.filter(
    (t) => t.status === "completed" || t.status === "cancelled",
  ).length;
  const active = tasks.filter(
    (t) => t.status === "in_progress" || t.status === "blocked",
  ).length;
  const base = `plan ${done}/${tasks.length}`;
  return active > 0 ? `${base} · ${active} active` : base;
}

/**
 * Unified live-task surface above the chat scroll area.
 *
 * Two independent sections: session tasks (todo_write mirror of THIS
 * conversation) and workspace project tasks (`.zelari/plan.json`,
 * shared by every conversation on the same cwd - ADR-0018). Project
 * tasks have no "Clear": they are durable workspace state, not chat
 * scratch space.
 */
export function LiveTasksPanel({ tasks, projectTasks, onClear }: Props) {
  const project = projectTasks ?? [];
  if (!tasks.length && !project.length) return null;
  return (
    <>
      <SessionTodosPanel todos={tasks} onClear={onClear} />
      {project.length > 0 ? (
        <div
          className="session-todos-panel live-tasks-project"
          aria-label="Workspace project tasks"
        >
          <div className="session-todos-head">
            <span className="session-todos-title">Project</span>
            {projectSummary(project) ? (
              <span className="session-todos-summary">
                {projectSummary(project)}
              </span>
            ) : null}
          </div>
          <ul className="session-todos-list">
            {project.map((t) => (
              <li key={t.id} className={`session-todo status-${t.status}`}>
                <span className="session-todo-mark" aria-hidden>
                  {t.status === "completed"
                    ? "V"
                    : t.status === "in_progress"
                      ? "?"
                      : t.status === "cancelled"
                        ? "-"
                        : t.status === "blocked"
                          ? "!"
                          : "•"}
                </span>
                <span className="session-todo-text">{t.content}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
