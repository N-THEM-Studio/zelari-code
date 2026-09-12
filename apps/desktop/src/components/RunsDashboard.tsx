/**
 * RunsDashboard (Desktop, F4 of the lead-chat plan).
 *
 * One global drawer over the whole run registry: every run the app still knows
 * about — active (`starting`/`running`) plus the retained
 * `finished`/`error`/`cancelled` ones — across ALL conversations, not just the
 * selected one. Clicking a row asks App to select that run's conversation (the
 * same handler the sidebar uses) and closes the drawer.
 *
 * Pure presentational by design: no `agentClient`, no Tauri, no polling, no
 * storage, no clock ticker. The registry is hook-local in App
 * (`useRunCoordinator`) and is passed in as a prop — exactly like the sidebar's
 * `unseenByConv` — so this renders identically in jsdom and in the shell.
 * Selectors are imported from `../runs/selectors` (never the `../runs` barrel,
 * which re-exports the coordinator and would drag Tauri into the tests).
 *
 * Sorting: active runs first (most recent start first), then the retained ones
 * by end time (`finishedAt ?? startedAt`) descending — the same recency the
 * registry keeps them in.
 *
 * Every row describes ITS run, not the selected chat:
 *   line 1 — status pill, project folder, conversation title, unseen mark,
 *            relative start ("2 min fa") and duration;
 *   line 2 — chat mode (the run "type") and the user prompt that started it.
 * Those derivations (project chip, prompt excerpt, relative time) are pure and
 * live in `./runDetails`, so they are unit-tested without a DOM.
 */
import { useMemo } from "react";
import { activeRunCount } from "../runs/selectors";
import type { RunRegistryState, RunRuntime, RunStatus } from "../runs/types";
import type { Conversation } from "../types";
import {
  formatClock,
  formatRelativeTime,
  projectLabel,
  promptExcerpt,
  runCwd,
} from "./runDetails";

export interface RunsDashboardProps {
  /** Closed → renders nothing (same contract as TentacleTracePanel). */
  open: boolean;
  /** Global run registry, owned by App (`useRunCoordinator`). Read-only here. */
  state: RunRegistryState;
  /** Lookup for `run.conversationId`: title, cwd, messages and mode of the row.
   *  An unknown id keeps the raw id as title and the labeled placeholders. */
  conversations: Conversation[];
  /** conversationId → unseen completion (`unseenResultsByConversation` in App). */
  unseenByConv: Record<string, boolean>;
  /** Row click: conversation to jump to. App owns selection (markSeen + rebind). */
  onSelectSession: (conversationId: string) => void;
  onClose: () => void;
  /** Test seam: clock of the relative-time column (defaults to `Date.now()`). */
  now?: number;
}

/** A run taking a composer slot right now (mirrors `activeRunCount`). */
function isActive(status: RunStatus): boolean {
  return status === "starting" || status === "running";
}

/** Recency key: a run that ended ranks by when it ended. */
function rankAt(run: RunRuntime): number {
  return run.finishedAt ?? run.startedAt;
}

/** Hand-rolled duration (no date lib, no deps): 45s / 2m / 1h 4m. */
function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

interface DashRow {
  run: RunRuntime;
  title: string;
  unseen: boolean;
  /** Basename of the run cwd ("zelari-code") or the labeled fallback ("app"). */
  project: string;
  /** Full cwd — only ever the chip tooltip; "" when unknown. */
  projectPath: string;
  /** User prompt that started this run, one line and truncated; else "—". */
  prompt: string;
  /** Chat mode (kraken/council/zelari): the "type" of the row. */
  mode?: string;
}

/** Active first (newest first), then the rest by end time desc. */
function buildRows(
  state: RunRegistryState,
  conversations: Conversation[],
  unseenByConv: Record<string, boolean>,
): DashRow[] {
  const byId = new Map<string, Conversation>(
    conversations.map((c): [string, Conversation] => [c.id, c]),
  );
  return Object.values(state.runsById)
    .map((run) => {
      const conv = byId.get(run.conversationId);
      const cwd = runCwd(run, conv);
      return {
        run,
        // A chat deleted while its run lived on must not lose its row: the raw
        // conversationId is the honest fallback title.
        title: conv?.title.trim() || run.conversationId,
        unseen: Boolean(run.unseenResult || unseenByConv[run.conversationId]),
        project: projectLabel(cwd),
        projectPath: cwd,
        prompt: promptExcerpt(conv?.messages, run.startedAt),
        mode: conv?.mode,
      };
    })
    .sort(
      (a, b) =>
        Number(isActive(b.run.status)) - Number(isActive(a.run.status)) ||
        rankAt(b.run) - rankAt(a.run),
    );
}

export function RunsDashboard({
  open,
  state,
  conversations,
  unseenByConv,
  onSelectSession,
  onClose,
  now,
}: RunsDashboardProps) {
  const rows = useMemo(
    () => buildRows(state, conversations, unseenByConv),
    [state, conversations, unseenByConv],
  );

  const live = activeRunCount(state);
  const clock = now ?? Date.now();

  if (!open) return null;

  return (
    <aside
      className="runs-dash workbench-panel"
      role="complementary"
      aria-label="Runs dashboard"
    >
      <header className="workbench-panel-head">
        <div className="workbench-panel-title">
          <span className="workbench-panel-icon" aria-hidden>
            ▤
          </span>
          <span>Runs</span>
          <span className="runs-dash-count" title={`${live} run in corso`}>
            {live}
          </span>
        </div>
        <button
          type="button"
          className="btn-ghost workbench-panel-close"
          onClick={onClose}
          aria-label="Chiudi la dashboard delle run"
          title="Chiudi (×)"
        >
          ×
        </button>
      </header>

      <div className="workbench-panel-meta">
        <span className="workbench-meta-item">{rows.length} run in registro</span>
        <span className="workbench-meta-item">{live} in corso</span>
      </div>

      <div className="workbench-panel-body">
        {rows.length === 0 ? (
          <div className="runs-dash-empty workbench-empty">Nessun run ancora</div>
        ) : (
          <div className="runs-dash-list">
            {rows.map(({ run, title, unseen, project, projectPath, prompt, mode }) => {
              const active = isActive(run.status);
              const elapsed = active
                ? clock - run.startedAt
                : rankAt(run) - run.startedAt;
              return (
                <button
                  key={run.runId}
                  type="button"
                  className="runs-dash-row"
                  data-run-id={run.runId}
                  data-conversation-id={run.conversationId}
                  data-status={run.status}
                  title={`Apri "${title}"`}
                  onClick={() => {
                    onSelectSession(run.conversationId);
                    onClose();
                  }}
                >
                  {/* Line 1: what ran, where, and when. */}
                  <span className="runs-dash-row-top">
                    <span className={`runs-dash-pill status-${run.status}`}>
                      {active ? <span className="runs-dash-dot" aria-hidden /> : null}
                      {run.status}
                    </span>
                    <span
                      className={`runs-dash-project${projectPath ? "" : " is-fallback"}`}
                      title={projectPath || "Nessuna cartella di lavoro impostata"}
                    >
                      {project}
                    </span>
                    <span className="runs-dash-title">{title}</span>
                    {unseen ? (
                      <span
                        className="runs-dash-unseen"
                        title="Risultato non visto"
                        aria-label="Risultato non visto"
                      >
                        ★
                      </span>
                    ) : null}
                    <span
                      className="runs-dash-ago"
                      title={`Avviata alle ${formatClock(run.startedAt)}`}
                    >
                      {formatRelativeTime(run.startedAt, clock)}
                    </span>
                    <span
                      className="runs-dash-time"
                      title={
                        active
                          ? `In corso da ${formatDuration(elapsed)}`
                          : `Durata ${formatDuration(elapsed)}`
                      }
                    >
                      {formatDuration(elapsed)}
                    </span>
                  </span>
                  {/* Line 2: the prompt this run was started with. */}
                  <span className="runs-dash-row-sub">
                    {mode ? (
                      <span className="runs-dash-type" title="Modalità della chat">
                        {mode}
                      </span>
                    ) : null}
                    <span className="runs-dash-prompt" title={prompt}>
                      {prompt}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
