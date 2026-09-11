import { useCallback, useState } from "react";
import type { LiveTask } from "../liveTasks/types";
import {
  isMissionResumable,
  missionRowLabel,
  missionStatusLabel,
  type MissionStateView,
} from "../liveTasks/missionState";
import { SessionTodosPanel } from "./SessionTodosPanel";
import { groupProjectTasks } from "../liveTasks/workspacePlan";

/** Collapsed-by-default since 2.35: "0" = user asked to keep it open. */
const LS_COLLAPSED = "zelari-desktop-tasks-panel-collapsed";

interface Props {
  tasks: LiveTask[];
  /** Workspace project tasks of the active cwd (`.zelari/plan.json`). */
  projectTasks?: LiveTask[];
  /** Persisted Zelari mission of the active cwd
   * (`.zelari/mission-state.json`); null/undefined = no mission on disk. */
  mission?: MissionStateView | null;
  /** Resume the persisted mission (`--resume-mission`). Omitted = the
   * Riprendi action is not offered (e.g. a run holds the workspace). */
  onResumeMission?: () => void;
  onClear?: () => void;
}

function counts(tasks: LiveTask[]): { done: number; total: number; active: number } {
  const done = tasks.filter(
    (t) => t.status === "completed" || t.status === "cancelled",
  ).length;
  const active = tasks.filter(
    (t) => t.status === "in_progress" || t.status === "blocked",
  ).length;
  return { done, total: tasks.length, active };
}

function summaryLabel(
  kind: string,
  c: { done: number; total: number; active: number },
): string {
  const base = `${kind} ${c.done}/${c.total}`;
  return c.active > 0 ? `${base} · ${c.active} attivi` : base;
}

/**
 * Unified live-task surface above the chat scroll area.
 *
 * 2.35: the whole surface lives behind ONE compact launcher pill (collapsed
 * by default, persisted) so task walls stop eating the chat: the pill shows
 * the combined summary ("Sessione 3/8 · Progetto 12/20 · 2 attivi"), one
 * click opens a single contained card with the session todos, the project
 * progress bar and the phase-grouped plan. Project tasks come from
 * `.zelari/plan.json` (shared by every conversation on the same cwd,
 * ADR-0018) and have no "Clear": they are durable workspace state.
 */
export function LiveTasksPanel({
  tasks,
  projectTasks,
  mission,
  onResumeMission,
  onClear,
}: Props) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LS_COLLAPSED) !== "0";
    } catch {
      return true;
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

  const project = projectTasks ?? [];
  // Completed/cancelled project tasks drop out of the panel: once marked
  // done they are history, not live state, and a fully closed plan hides
  // the Project section entirely instead of leaving a giant wall of
  // checked items. The summary keeps counting them so "plan 18/18" still
  // reads correctly while active work remains.
  // EXCEPTION (t62): a completed task carrying the 'reopened' or 'stale'
  // hygiene flag re-appears with a badge — drift after completion is
  // exactly what the panel exists to surface. Other flags (e.g.
  // 'overlap') stay advisory-only and do not resurrect history.
  const active = project.filter(
    (t) =>
      (t.status !== "completed" && t.status !== "cancelled") ||
      t.flags?.includes("reopened") ||
      t.flags?.includes("stale"),
  );
  const missionView = mission ?? null;
  // The mission pill is its own reason to exist: a persisted mission shows
  // even with zero todos and zero project tasks.
  if (!tasks.length && !active.length && !missionView) return null;

  const sessionC = counts(tasks);
  const projectC = counts(project);
  // "Sta lavorando": qualsiasi task attivo o bloccato anima l'icona.
  const workingCount =
    tasks.filter((t) => t.status === "in_progress" || t.status === "blocked").length +
    project.filter((t) => t.status === "in_progress" || t.status === "blocked").length;
  const parts = [
    missionView
      ? `Missione · ${missionStatusLabel(missionView.status)}`
      : null,
    tasks.length ? summaryLabel("Sessione", sessionC) : null,
    project.length ? summaryLabel("Progetto", projectC) : null,
  ].filter(Boolean) as string[];
  const progressPct = projectC.total
    ? Math.round((projectC.done / projectC.total) * 100)
    : 0;

  // Floating popover: the calendar fab is the anchor, the card drops DOWN
  // from it. Both are absolutely positioned over the chat shell — they take
  // ZERO flow space, so the chat keeps the full column height.
  const groups = groupProjectTasks(active);
  return (
    <div className="live-tasks-pop">
      <button
        type="button"
        className={`live-tasks-fab${workingCount > 0 ? " is-working" : ""}${collapsed ? "" : " is-open"}`}
        onClick={toggle}
        aria-expanded={!collapsed}
        aria-label={
          workingCount > 0
            ? `Task in corso: ${workingCount}. ${collapsed ? "Apri" : "Chiudi"} il riquadro task e todo`
            : `${collapsed ? "Apri" : "Chiudi"} il riquadro task e todo`
        }
        title={`${collapsed ? "Apri" : "Chiudi"} il riquadro task e todo`}
      >
        <span className="live-tasks-fab-icon" aria-hidden>
          <svg viewBox="0 0 20 20" width="18" height="18">
            <rect x="2" y="4" width="16" height="14" rx="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <line x1="2" y1="8.5" x2="18" y2="8.5" stroke="currentColor" strokeWidth="1.6" />
            <line x1="6.5" y1="2" x2="6.5" y2="6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <line x1="13.5" y1="2" x2="13.5" y2="6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <circle className="cal-dot d1" cx="7" cy="12" r="1.35" fill="currentColor" />
            <circle className="cal-dot d2" cx="10.5" cy="12" r="1.35" fill="currentColor" />
            <circle className="cal-dot d3" cx="14" cy="12" r="1.35" fill="currentColor" />
            <circle className="cal-dot d4" cx="7" cy="15.2" r="1.35" fill="currentColor" />
            <circle className="cal-dot d5" cx="10.5" cy="15.2" r="1.35" fill="currentColor" />
            <circle className="cal-dot d6" cx="14" cy="15.2" r="1.35" fill="currentColor" />
          </svg>
        </span>
        {workingCount > 0 ? (
          <span className="live-tasks-fab-badge" aria-hidden>
            {workingCount}
          </span>
        ) : null}
      </button>
      {collapsed ? null : (
        <div className="live-tasks-card session-todos-panel" aria-label="Task e todo">
          <div className="session-todos-head">
            <span className="session-todos-title">Task &amp; Progetto</span>
            {parts.length ? (
              <span className="session-todos-summary">{parts.join(" · ")}</span>
            ) : null}
            <button
              type="button"
              className="live-tasks-close"
              onClick={toggle}
              title="Chiudi il riquadro task e todo"
              aria-label="Chiudi il riquadro task e todo"
            >
              ✕
            </button>
          </div>

      {missionView ? (
        <section className="live-tasks-section" aria-label="Missione Zelari">
          <div className="session-todos-head">
            <span className="session-todos-title">Missione</span>
            <span className="session-todos-summary">
              {missionStatusLabel(missionView.status)}
            </span>
            {isMissionResumable(missionView) && onResumeMission ? (
              <button
                type="button"
                className="btn-ghost session-todos-clear"
                onClick={onResumeMission}
                title="Riprende la missione salvata in .zelari/mission-state.json"
              >
                Riprendi
              </button>
            ) : null}
          </div>
          <ul className="session-todos-list">
            <li
              className={`session-todo${
                missionView.status === "running"
                  ? " status-in_progress"
                  : isMissionResumable(missionView)
                    ? ""
                    : " status-completed"
              }`}
            >
              <span className="session-todo-mark" aria-hidden>
                {isMissionResumable(missionView) ? "▶" : "✓"}
              </span>
              <span
                className="session-todo-text"
                title={`.zelari/mission-state.json — missionId ${missionView.missionId}`}
              >
                {missionRowLabel(missionView)}
              </span>
            </li>
          </ul>
        </section>
      ) : null}

      {project.length ? (
        <div className="live-tasks-progress" aria-label={`Piano ${progressPct}%`}>
          <div className="live-tasks-bar">
            <div
              className="live-tasks-bar-fill"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <span className="live-tasks-progress-label">{progressPct}%</span>
        </div>
      ) : null}

      <SessionTodosPanel todos={tasks} onClear={onClear} />

      {active.length > 0 ? (
        <section
          className="live-tasks-section live-tasks-project"
          aria-label="Workspace project tasks"
        >
          <div className="session-todos-head">
            <span className="session-todos-title">Progetto</span>
          </div>
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
                      {t.flags?.includes("reopened") ? (
                        <span
                          className="live-task-badge live-task-badge-reopened"
                          title="File dichiarati toccati da una sessione successiva al completamento"
                        >
                          ⚠︎ riaperto
                        </span>
                      ) : null}
                      {t.flags?.includes("stale") ? (
                        <span
                          className="live-task-badge live-task-badge-stale"
                          title="Commit successivi sui file dichiarati dal task"
                        >
                          ⧗ stale
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </section>
        ) : null}
        </div>
      )}
    </div>
  );
}
