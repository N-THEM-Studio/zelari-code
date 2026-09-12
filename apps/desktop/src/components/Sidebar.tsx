/**
 * Sidebar (Desktop, F1 + the F2 row selection of the lead-chat plan).
 *
 * Extracted from the inline block in App.tsx with the behaviour unchanged:
 * selection, archive/unarchive/delete, folder collapse, run/unseen badges,
 * footer status, drag-to-resize handle. Two things are new here:
 *
 *   - two sections: "Missioni" = conversations owning a 2.0 spine session
 *     (`Conversation.sessionId`), "Chat" = the rest. Same localStorage store,
 *     no migration, nothing deleted;
 *   - under the ACTIVE mission, the tentacles of its run, from the activity
 *     state App already receives (`agent-event`, `parentId` links). Read-only
 *     for the run: no new channel, no new IPC, no polling, no new storage.
 *     F2 adds the row SELECTION only: App owns the trace panel, nothing is
 *     read or written here.
 *
 * The activity stream is global (one `RunActivityState`, one `runId`): the
 * hierarchy is painted only when that run id is the active conversation's own
 * run - a stale run never lands under a mission.
 */
import { useMemo, type PointerEvent as ReactPointerEvent } from "react";
import type { ActivityAgent, RunActivityState } from "../activity";
import { folderLabelFromCwd, groupSessionsByFolder } from "../sessionGroups";
import type { Conversation, SessionFilter } from "../types";
import { buildHierarchy, MissionTentacles, type HierarchyRow } from "./MissionTentacles";
import { VerdictBadge } from "./VerdictBadge";
import type { TentacleVerdictView } from "./tentacleVerdict";

/** Resize handle handlers; App owns the width it persists (`--sidebar-w`). */
export interface SidebarResizer {
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
}

export interface SidebarProps {
  /** Conversations of the current Active/Archived tab (App owns the filter). */
  sessions: Conversation[];
  filter: SessionFilter;
  activeId: string;
  /** Run registry accessor (M2 multiplexing) - drives the per-chat badge. */
  isRunning: (id: string) => boolean;
  unseenByConv: Record<string, boolean>;
  collapsedFolders: Set<string>;
  onToggleFolder: (key: string) => void;
  onNewChat: () => void;
  newChatDisabled: boolean;
  onSelect: (c: Conversation) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onDelete: (id: string) => void;
  onFilterChange: (f: SessionFilter) => void;
  onOpenSettings: () => void;
  cliOk: boolean;
  statusLine: string;
  resizer: SidebarResizer;
  /** Latest run activity, lifted to App (`useRunActivity`) - read-only. */
  activity: RunActivityState;
  /** Run id of the active conversation; attribution guard for the hierarchy. */
  activeRunId?: string;
  /**
   * F2: a tentacle row was clicked. App owns the trace panel; the sidebar
   * only reports the selection (no file read, no channel, no state here).
   */
  onSelectTentacle: (agent: ActivityAgent) => void;
  /** F2: tentacle whose trace is open, highlighted with `aria-pressed`. */
  selectedTentacleId?: string | null;
  /**
   * F3: mission-level verification verdict of a conversation, read by App from
   * the `verification_run` event (the same source as `VerificationStatusCard`).
   * Rendered with an explicit `mission` label - never attributed to a tentacle.
   * Absent = no badge at all (never a PASS).
   */
  missionVerdictFor?: (convId: string) => TentacleVerdictView | undefined;
}

function formatTime(ts: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ts));
  } catch {
    return "";
  }
}

/**
 * Tentacle rows under the active mission live in `MissionTentacles.tsx` (F3
 * extracted them to make room for the per-tentacle verification badge).
 */

/** Run / completed / plain bubble badge, unchanged from the inline sidebar. */
function RunBadge({ running, unseen }: { running: boolean; unseen: boolean }) {
  if (running) return <span className="session-run-badge" title="Run in corso" aria-label="Run in corso">●</span>;
  if (unseen) return <span className="session-run-badge is-done" title="Run completata" aria-label="Run completata">✓</span>;
  return <span className="session-bubble" aria-hidden>💬</span>;
}

function SessionRow({
  c,
  props,
  hierarchy,
  showHierarchy,
}: {
  c: Conversation;
  props: SidebarProps;
  hierarchy: HierarchyRow[];
  showHierarchy: boolean;
}) {
  const { activeId, isRunning, unseenByConv, onSelect, onArchive, onUnarchive, onDelete } = props;
  /** F3: mission-level verdict of THIS conversation, if the backend sent one. */
  const missionVerdict = props.missionVerdictFor?.(c.id);
  return (
    <div className={`session-item-wrap${c.id === activeId ? " active" : ""}`}>
      <button type="button" className="session-item" onClick={() => onSelect(c)}>
        <span className="session-title">{c.title}</span>
        <RunBadge running={isRunning(c.id)} unseen={Boolean(unseenByConv[c.id])} />
        {missionVerdict ? <VerdictBadge scope="mission" {...missionVerdict} /> : null}
        <span className="session-folder" title={c.cwd ? c.cwd : undefined}>
          📁 {c.cwd ? folderLabelFromCwd(c.cwd) : "No folder"}
        </span>
        <span className="session-meta">
          {c.mode} · {c.phase} · {formatTime(c.updatedAt)}
        </span>
      </button>
      <div className="session-actions">
        {c.archived ? (
          <button type="button" title="Unarchive" onClick={() => onUnarchive(c.id)}>↩</button>
        ) : (
          <button type="button" title="Archive" onClick={() => onArchive(c.id)}>⬇</button>
        )}
        <button type="button" title="Delete" className="danger" onClick={() => onDelete(c.id)}>×</button>
      </div>
      {showHierarchy && hierarchy.length ? (
        <MissionTentacles
          rows={hierarchy}
          onSelect={props.onSelectTentacle}
          selectedId={props.selectedTentacleId}
        />
      ) : null}
    </div>
  );
}

export function Sidebar(props: SidebarProps) {
  const { sessions, filter, activeId, activity, activeRunId, resizer } = props;
  const missions = useMemo(() => sessions.filter((c) => Boolean(c.sessionId)), [sessions]);
  const chats = useMemo(() => sessions.filter((c) => !c.sessionId), [sessions]);
  const hierarchy = useMemo(() => buildHierarchy(activity), [activity]);
  /** Only the run of the ACTIVE mission may paint a hierarchy under it. */
  const hierarchyFor = activeRunId && activity.runId === activeRunId ? activeId : undefined;

  /** One section = label + the folder grouping the sidebar always had. */
  const section = (label: string, list: Conversation[]) =>
    list.length ? (
      <div key={label}>
        <div className="session-label">{label}</div>
        {groupSessionsByFolder(list).map((g) => {
          const groupCollapsed = props.collapsedFolders.has(g.key);
          return (
            <div key={g.key} className="session-group">
              <button
                type="button"
                className="session-group-head"
                title={g.path || undefined}
                aria-expanded={!groupCollapsed}
                onClick={() => props.onToggleFolder(g.key)}
              >
                <span className="session-group-chevron" aria-hidden>{groupCollapsed ? "▸" : "▾"}</span>
                <span className="session-group-name">{g.label}</span>
                <span className="session-group-count">{g.sessions.length}</span>
              </button>
              {!groupCollapsed &&
                g.sessions.map((c) => (
                  <SessionRow
                    key={c.id}
                    c={c}
                    props={props}
                    hierarchy={hierarchy}
                    showHierarchy={c.id === hierarchyFor}
                  />
                ))}
            </div>
          );
        })}
      </div>
    ) : null;

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <button type="button" className="btn-new" onClick={props.onNewChat} disabled={props.newChatDisabled}>
          <span aria-hidden>+</span> New chat
        </button>
        <div className="session-filter">
          <button type="button" className={filter === "active" ? "active" : ""} onClick={() => props.onFilterChange("active")}>
            Active
          </button>
          <button type="button" className={filter === "archived" ? "active" : ""} onClick={() => props.onFilterChange("archived")}>
            Archived
          </button>
        </div>
      </div>

      <div className="session-list">
        {sessions.length === 0 && (
          <div className="session-empty">
            {filter === "archived" ? "No archived chats" : "No active chats"}
          </div>
        )}
        {section("Missioni", missions)}
        {section("Chat", chats)}
      </div>

      <div className="sidebar-foot">
        <button type="button" className="btn-settings" onClick={props.onOpenSettings}>⚙ Settings</button>
        <div className="status-pill">
          <span className={`status-dot ${props.cliOk ? "ok" : "bad"}`} aria-hidden />
          <div>
            <div>{props.statusLine}</div>
          </div>
        </div>
      </div>
      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Ridimensiona la barra laterale (doppio clic: ripristina)"
        title="Trascina per ridimensionare — doppio clic per ripristinare"
        onPointerDown={resizer.onPointerDown}
        onPointerMove={resizer.onPointerMove}
        onPointerUp={resizer.onPointerUp}
        onDoubleClick={resizer.onDoubleClick}
      />
    </aside>
  );
}
