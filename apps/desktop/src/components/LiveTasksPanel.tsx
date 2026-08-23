import { useCallback, useState } from "react";
import type { LiveTask } from "../liveTasks/types";
import { SessionTodosPanel } from "./SessionTodosPanel";
import { groupProjectTasks } from "../liveTasks/workspacePlan";

const LS_PROJECT_COLLAPSED = "zelari-desktop-project-tasks-collapsed";

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
 * tasks are grouped under their plan phase (P0 → Release ordering comes
 * from `phases[].order`), so a normalized plan reads as a sequenced
 * roadmap instead of a flat wall of tasks. Project tasks have no
 * "Clear": they are durable workspace state, not chat scratch space.
 * Both sections are collapsible (state persisted per section) so long
 * task walls can be folded away while chatting.
 */
export function LiveTasksPanel({ tasks, projectTasks, onClear }: Props) {
  const [projectCollapsed, setProjectCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LS_PROJECT_COLLAPSED) === "1";
    } catch {
      return false;
    }
  });

  const toggleProject = useCallback(() => {
    setProjectCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(LS_PROJECT_COLLAPSED, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const project = projectTasks ?? [];
  // Completed/cancelled project tasks drop out of the panel: once marked
  // done they are history, not live state, and a fully closed plan hides
  // the Project section entirely instead of leaving a giant wall of
  // checked items. The summary keeps counting them so "plan 18/18" still
  // reads correctly while active work remains.
  const active = project.filter(
    (t) => t.status !== "completed" && t.status !== "cancelled",
  );
  const groups = groupProjectTasks(active);
  if (!tasks.length && !active.length) return null;
  return (
    <>
      <SessionTodosPanel todos={tasks} onClear={onClear} />
      {active.length > 0 ? (
        <div
          className={`session-todos-panel live-tasks-project${
            projectCollapsed ? " collapsed" : ""
          }`}
          aria-label="Workspace project tasks"
        >
          <div className="session-todos-head">
            <button
              type="button"
              className="session-todos-toggle"
              onClick={toggleProject}
              aria-expanded={!projectCollapsed}
              title={
                projectCollapsed ? "Expand project tasks" : "Collapse project tasks"
              }
            >
              <span className="session-todos-chevron" aria-hidden>
                {projectCollapsed ? "▸" : "▾"}
              </span>
              <span className="session-todos-title">Project</span>
            </button>
            {projectSummary(project) ? (
              <span className="session-todos-summary">
                {projectSummary(project)}
              </span>
            ) : null}
          </div>
          {projectCollapsed ? null : (
            <div className="live-tasks-groups">
              {groups.map((g) => (
                <section
                  key={g.key}
                  className="live-tasks-phase-group"
                  aria-label={`Fase ${g.label}`}
                >
                  <div className="live-tasks-phase">
                    <span className="live-tasks-phase-name">{g.label}</span>
                    <span className="live-tasks-phase-count">
                      {g.tasks.length}
                    </span>
                  </div>
                  <ul className="session-todos-list live-tasks-phase-list">
                    {g.tasks.map((t) => (
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
                </section>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}
