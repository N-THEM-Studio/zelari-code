/**
 * Sidebar (Desktop, the left rail of the lead-chat plan).
 *
 * Extracted from the inline block in App.tsx with the behaviour unchanged:
 * selection, archive/unarchive/delete, folder collapse, run/unseen badges,
 * footer status, drag-to-resize handle. IDE-round redesign:
 *
 *   - ONE hierarchy: the project folder (cwd) is the header of each group and
 *     gets the visual weight; conversation rows are compact (title + meta on
 *     two lines) and NEVER repeat the folder. The old Missioni/Chat split
 *     (by `Conversation.sessionId`) is folded into the same list — missions
 *     keep their verdict badge and the mode stays in the row meta.
 *   - collapsible: `collapsed` renders a minimal icon rail (expand, new chat,
 *     settings) so the chat area can take the whole width.
 *
 * grok-round adds the inline rename: the row turns into a prefilled input, the
 * commit is trimmed and non-empty by construction, and the store/persistence
 * stay in App (`onRename`) exactly like archive/delete.
 *
 * Nothing from the Kraken activity stream is rendered here: the tentacle
 * hierarchy that used to be painted under the ACTIVE mission's row is gone for
 * good. The stream keeps feeding the chat-area Kraken Activity panel only, so
 * this file never sees a run at all.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { groupSessionsByFolder } from "../sessionGroups";
import type { Conversation, SessionFilter } from "../types";
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
  /**
   * Rename a conversation in place (grok-round). App owns the store and the
   * persistence (the same `setConversations` → localStorage path archive and
   * delete use); the sidebar only reports the committed title, already
   * trimmed and non-empty — an empty title is refused here and never reaches
   * App, so a row can never end up nameless.
   */
  onRename: (id: string, title: string) => void;
  onFilterChange: (f: SessionFilter) => void;
  onOpenSettings: () => void;
  /** IDE round: render the minimal icon rail instead of the full sidebar. */
  collapsed: boolean;
  /** IDE round: toggle between the full sidebar and the icon rail. */
  onToggleCollapsed: () => void;
  cliOk: boolean;
  statusLine: string;
  resizer: SidebarResizer;
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
 * Run / completed / plain bubble badge, unchanged from the inline sidebar.
 */
function RunBadge({ running, unseen }: { running: boolean; unseen: boolean }) {
  if (running) return <span className="session-run-badge" title="Run in corso" aria-label="Run in corso">●</span>;
  if (unseen) return <span className="session-run-badge is-done" title="Run completata" aria-label="Run completata">✓</span>;
  return <span className="session-bubble" aria-hidden>💬</span>;
}

function SessionRow({ c, props }: { c: Conversation; props: SidebarProps }) {
  const { activeId, isRunning, unseenByConv, onSelect, onArchive, onUnarchive, onDelete } = props;
  /** F3: mission-level verdict of THIS conversation, if the backend sent one. */
  const missionVerdict = props.missionVerdictFor?.(c.id);

  /**
   * grok-round rename: the row becomes an inline `<input>` prefilled with the
   * title. `renamingRef` is the synchronous twin of `renaming` because Enter
   * and the blur that follows it can land in the same tick — the guard makes
   * the commit idempotent, so a keystroke never renames twice.
   */
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState(c.title);
  const renamingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus + select-all on open: the whole title is the thing being replaced.
  useEffect(() => {
    if (!renaming) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [renaming]);

  const startRename = () => {
    renamingRef.current = true;
    setTitleDraft(c.title);
    setRenaming(true);
  };

  /** Enter / blur: trim, refuse empty, keep the old title when unchanged. */
  const commitRename = () => {
    if (!renamingRef.current) return;
    renamingRef.current = false;
    setRenaming(false);
    const next = titleDraft.trim();
    if (!next || next === c.title) {
      setTitleDraft(c.title);
      return;
    }
    props.onRename(c.id, next);
  };

  /** Esc: back to the stored title, nothing is reported to App. */
  const cancelRename = () => {
    if (!renamingRef.current) return;
    renamingRef.current = false;
    setRenaming(false);
    setTitleDraft(c.title);
  };

  return (
    <div
      className={`session-item-wrap${c.id === activeId ? " active" : ""}${renaming ? " is-renaming" : ""}`}
    >
      {renaming ? (
        <input
          ref={inputRef}
          className="session-item-rename"
          value={titleDraft}
          aria-label="Conversation title"
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              commitRename();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              cancelRename();
            }
          }}
        />
      ) : (
        <button type="button" className="session-item" onClick={() => onSelect(c)}>
          {/* IDE round: two compact lines — title + status badges on the first,
              mode + time on the second. The folder lives ONCE in the group
              header above, never repeated here. */}
          <span className="session-title-row">
            <span className="session-title">{c.title}</span>
            <RunBadge running={isRunning(c.id)} unseen={Boolean(unseenByConv[c.id])} />
            {missionVerdict ? <VerdictBadge scope="mission" {...missionVerdict} /> : null}
          </span>
          <span className="session-meta">
            {c.mode} · {formatTime(c.updatedAt)}
          </span>
        </button>
      )}
      <div className="session-actions">
        {renaming ? null : (
          <>
            <button
              type="button"
              title="Rename"
              aria-label={`Rename ${c.title}`}
              onClick={startRename}
            >
              ✎
            </button>
            {c.archived ? (
              <button type="button" title="Unarchive" onClick={() => onUnarchive(c.id)}>↩</button>
            ) : (
              <button type="button" title="Archive" onClick={() => onArchive(c.id)}>⬇</button>
            )}
            <button type="button" title="Delete" className="danger" onClick={() => onDelete(c.id)}>×</button>
          </>
        )}
      </div>
    </div>
  );
}

export function Sidebar(props: SidebarProps) {
  const { sessions, filter, resizer, collapsed } = props;

  /** IDE round: collapsed = minimal icon rail, nothing else is rendered. */
  if (collapsed) {
    return (
      <aside className="sidebar is-collapsed" aria-label="Barra laterale ridotta">
        <div className="sidebar-rail">
          <button
            type="button"
            className="rail-btn"
            title="Espandi la barra laterale"
            aria-label="Espandi la barra laterale"
            onClick={props.onToggleCollapsed}
          >
            »
          </button>
          <button
            type="button"
            className="rail-btn"
            title="Nuova chat"
            aria-label="Nuova chat"
            onClick={props.onNewChat}
            disabled={props.newChatDisabled}
          >
            ＋
          </button>
          <button
            type="button"
            className="rail-btn"
            title="Impostazioni"
            aria-label="Impostazioni"
            onClick={props.onOpenSettings}
          >
            ⚙
          </button>
        </div>
      </aside>
    );
  }

  /** One group per project folder — the header carries the project name. */
  const groups = useMemo(() => groupSessionsByFolder(sessions), [sessions]);

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="sidebar-top-row">
          <button type="button" className="btn-new" onClick={props.onNewChat} disabled={props.newChatDisabled}>
            <span aria-hidden>+</span> New chat
          </button>
          <button
            type="button"
            className="btn-collapse"
            title="Riduci la barra laterale"
            aria-label="Riduci la barra laterale"
            onClick={props.onToggleCollapsed}
          >
            «
          </button>
        </div>
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
        {groups.map((g) => {
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
                  <SessionRow key={c.id} c={c} props={props} />
                ))}
            </div>
          );
        })}
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
