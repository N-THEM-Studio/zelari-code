/**
 * Kraken Activity panel (PHASE 3 §36–45).
 *
 * Live execution state of the Kraken lead and tentacles: role glyphs,
 * status, duration, model routing, worktree, current tool and recent
 * tool activity. Self-subscribes to the agent-event stream and renders
 * nothing until an agent_spawned arrives (inert by default).
 */
import { useEffect, useState } from "react";
import {
  formatActivityDuration,
  roleGlyph,
  selectGraphGroups,
  selectLead,
  selectPendingControls,
  selectRecentTools,
  selectStatusCounts,
  selectTentacles,
  statusGlyph,
} from "../activity";
import { useRunActivity } from "../activity/useRunActivity";

function shortWorktree(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? ".../" + parts.slice(-2).join("/") : path;
}

function AgentRow({
  agent,
  expanded,
  onToggle,
}: {
  agent: ReturnType<typeof useRunActivity>["agents"][string];
  expanded: boolean;
  onToggle: () => void;
}) {
  const tools = selectRecentTools(agent, 8);
  return (
    <div
      style={{
        borderLeft: "2px solid var(--accent, #4b9cd3)",
        margin: "4px 0 4px 8px",
        padding: "4px 8px",
        cursor: "pointer",
      }}
      onClick={onToggle}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <span aria-hidden>{roleGlyph(agent.role)}</span>
        <strong>{agent.title || agent.id}</strong>
        <span aria-hidden>{statusGlyph(agent.status)}</span>
        <span style={{ opacity: 0.8 }}>
          {formatActivityDuration(agent.durationMs ?? (agent.startedAt ? Date.now() - agent.startedAt : undefined))}
        </span>
        {agent.model ? <span style={{ opacity: 0.7 }}>· {agent.model}</span> : null}
        {agent.currentTool ? <span>· {agent.currentTool}…</span> : null}
      </div>
      {expanded ? (
        <div style={{ fontSize: "0.85em", opacity: 0.9, marginTop: 4 }}>
          {agent.worktree ? <div>worktree: {shortWorktree(agent.worktree)}</div> : null}
          {agent.graphNodeId ? <div>graph node: {agent.graphNodeId}</div> : null}
          {agent.scope?.length ? <div>scope: {agent.scope.join(", ")}</div> : null}
          {agent.tokenUsage?.output ? <div>output tokens: {agent.tokenUsage.output}</div> : null}
          {tools.length ? (
            <div style={{ marginTop: 4 }}>
              {tools.map((t) => (
                <div key={t.id} style={{ display: "flex", gap: 6 }}>
                  <span aria-hidden>{t.status === "failed" ? "✗" : t.status === "completed" ? "✓" : "●"}</span>
                  <span>{t.tool}</span>
                  {t.summary ? <span style={{ opacity: 0.7 }}>{t.summary}</span> : null}
                  {t.durationMs ? <span style={{ opacity: 0.6 }}>{formatActivityDuration(t.durationMs)}</span> : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function KrakenActivity() {
  const state = useRunActivity();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [, forceTick] = useState(0);
  const lead = selectLead(state);
  const tentacles = selectTentacles(state);
  const counts = selectStatusCounts(state);
  const graph = selectGraphGroups(state);
  const warnings = state.warnings;
  const pending = selectPendingControls(state);
  const hasAgents = state.agentOrder.length > 0;

  // 1s ticker while any agent is running (elapsed durations).
  useEffect(() => {
    if (!Object.values(state.agents).some((a) => a.status === "running")) return;
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [state.agents]);

  if (!hasAgents) return null;

  return (
    <section
      aria-label="Kraken Activity"
      style={{
        borderTop: "1px solid rgba(128,128,128,0.4)",
        marginTop: 8,
        paddingTop: 8,
        fontSize: "0.9em",
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
        <strong>KRAKEN ACTIVITY</strong>
        <span style={{ opacity: 0.7 }}>
          {counts.completed + counts.failed + counts.cancelled}/{state.agentOrder.length} done
          {counts.running ? ` · ${counts.running} running` : ""}
          {counts.failed ? ` · ${counts.failed} failed` : ""}
        </span>
      </div>

      {lead ? (
        <div style={{ margin: "6px 0" }}>
          <span aria-hidden>{roleGlyph(lead.role)}</span> <strong>{lead.title || "Lead"}</strong>{" "}
          <span aria-hidden>{statusGlyph(lead.status)}</span>{" "}
          {formatActivityDuration(lead.durationMs ?? (lead.startedAt ? Date.now() - lead.startedAt : undefined))}
          {lead.model ? <span style={{ opacity: 0.7 }}> · {lead.model}</span> : null}
        </div>
      ) : null}

      {tentacles.length ? (
        <div style={{ marginTop: 4 }}>
          {tentacles.map((a) => (
            <AgentRow
              key={a.id}
              agent={a}
              expanded={expandedId === a.id}
              onToggle={() => setExpandedId(expandedId === a.id ? null : a.id)}
            />
          ))}
        </div>
      ) : null}

      {graph.length ? (
        <div style={{ marginTop: 6, opacity: 0.9 }}>
          <div style={{ opacity: 0.7 }}>GRAPH</div>
          {graph.map((g) => (
            <div key={g.nodeId}>
              {g.nodeId}{" "}
              <span style={{ opacity: 0.7 }}>
                ({g.agents.filter((a) => a.status === "completed").length}/{g.agents.length})
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {warnings.length ? (
        <div style={{ marginTop: 6 }}>
          {warnings.slice(-3).map((w, i) => (
            <div key={`${w.agentId}-${i}`} style={{ color: "#d08770" }}>
              ⚠ {w.agentId ? `${w.agentId}: ` : ""}
              {w.message}
            </div>
          ))}
        </div>
      ) : null}

      {pending.length ? (
        <div style={{ marginTop: 4, opacity: 0.75 }}>
          Pending controls: {pending.length} ({pending.map((c) => `${c.type}:${c.state}`).join(", ")})
        </div>
      ) : null}
    </section>
  );
}
