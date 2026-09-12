/**
 * Tentacle rows under the active mission (Desktop F1 hierarchy + F2 selection
 * + F3 verification badge).
 *
 * Extracted from `Sidebar.tsx` unchanged apart from the badge: read-only with
 * respect to the run (F1), clicking a row asks App to open that tentacle's live
 * trace (F2), and each row now paints its own ADR-0023 verification verdict
 * (F3) from the backend caption the row already shows (`phaseMessage`, i.e.
 * `agent_status.message`) — see `tentacleVerdict.ts`. A row without a signal
 * renders "—": it never inherits the mission verdict.
 */
import {
  formatActivityDuration,
  roleGlyph,
  selectLead,
  selectTentacles,
  statusGlyph,
  type ActivityAgent,
  type RunActivityState,
} from "../activity";
import { VerdictBadge } from "./VerdictBadge";
import { readTentacleVerdict } from "./tentacleVerdict";

export interface HierarchyRow {
  agent: ActivityAgent;
  depth: number;
}

/** Tentacles of the run in flight, nested by `parentId` (depth-first from the
 * lead, depth capped; flat list when no agent carries a parentId). */
export function buildHierarchy(state: RunActivityState): HierarchyRow[] {
  const agents = selectTentacles(state);
  const lead = selectLead(state);
  const rows: HierarchyRow[] = [];
  if (lead) {
    const walk = (parentId: string, depth: number): void => {
      if (depth > 2) return;
      for (const agent of agents) {
        if (agent.parentId !== parentId) continue;
        rows.push({ agent, depth });
        walk(agent.id, depth + 1);
      }
    };
    walk(lead.id, 0);
  }
  return rows.length ? rows : agents.map((agent) => ({ agent, depth: 0 }));
}

/**
 * Tentacle rows under the active mission. Read-only with respect to the run
 * (F1) plus the F2 selection: clicking a row asks App to open that tentacle's
 * live trace. A `<button>` keeps it keyboard reachable for free.
 */
export function MissionTentacles({
  rows,
  onSelect,
  selectedId,
}: {
  rows: HierarchyRow[];
  onSelect: (agent: ActivityAgent) => void;
  selectedId?: string | null;
}) {
  const box = { margin: "2px 0 6px 6px", paddingLeft: 8, borderLeft: "2px solid var(--accent, #4b9cd3)", fontSize: "0.82em" };
  const name = { maxWidth: 128, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" };
  /** Button reset so the row looks exactly as it did as a `<div>`. */
  const row = { display: "flex", gap: 6, alignItems: "baseline", width: "100%", padding: 0, border: 0, background: "none", color: "inherit", font: "inherit", textAlign: "left", cursor: "pointer" } as const;
  return (
    <div aria-label="Tentacles della missione attiva" style={box}>
      {rows.map(({ agent, depth }) => (
        <button
          key={agent.id}
          type="button"
          className="tentacle-row"
          title={`${agent.title || agent.id} — trace live`}
          aria-pressed={agent.id === selectedId}
          data-agent-id={agent.id}
          onClick={() => onSelect(agent)}
          style={{ ...row, paddingLeft: depth * 10, opacity: agent.status === "running" ? 1 : 0.75 }}
        >
          <span aria-hidden>{roleGlyph(agent.role)}</span>
          <span aria-hidden>{statusGlyph(agent.status)}</span>
          <span style={name}>{agent.title || agent.id}</span>
          {/* F3: this row's own verification signal, or "—" (never the mission's). */}
          <VerdictBadge scope="tentacle" {...readTentacleVerdict(agent)} />
          {/* Caption or final duration - never a clock read: no ticker here. */}
          {agent.phaseMessage ? (
            <span style={{ opacity: 0.75 }}>{agent.phaseMessage}</span>
          ) : agent.durationMs !== undefined ? (
            <span style={{ opacity: 0.6 }}>{formatActivityDuration(agent.durationMs)}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
