/**
 * Kraken Activity panel (PHASE 3 §36–45).
 *
 * Live execution state of the Kraken lead and tentacles: role glyphs,
 * status, duration, model routing, worktree, current tool and recent
 * tool activity, cross-provider routing and degraded tool channels.
 * Self-subscribes to the agent-event stream and renders
 * nothing until an agent_spawned arrives (inert by default).
 *
 * Conversation scope (M2): the panel is scoped by `conversationId` — it
 * reduces only events whose run envelope names that conversation, and never
 * self-declares as "the active chat". A background run elsewhere keeps
 * accumulating in the shared store without painting here.
 */
import { useEffect, useState } from "react";
import {
  displayThinkingEffort,
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

/**
 * Quiet chip next to the model: the thinking effort ACTUALLY applied to this
 * tentacle (agent_spawned.thinking, ADR-0017). Renders nothing for the
 * inherit/default cases — an always-present "effort: auto" would be noise.
 */
function ThinkingChip({ thinking }: { thinking?: string }) {
  const effort = displayThinkingEffort(thinking);
  if (!effort) return null;
  return (
    <span
      className="kraken-thinking-chip"
      title={`Thinking effort applied to this agent: ${effort}`}
    >
      {`effort: ${effort}`}
    </span>
  );
}

type Agent = ReturnType<typeof useRunActivity>["agents"][string];

/**
 * Where the agent runs: the model, prefixed by its provider when that differs
 * from the chat's (lead) provider — a tentacle routed to another family, or
 * moved there by a fallback retry, is exactly what the user wants to notice.
 */
function RouteChip({ agent, leadProvider }: { agent: Agent; leadProvider?: string }) {
  if (!agent.model) return null;
  const cross =
    agent.role !== "lead" &&
    Boolean(agent.provider && leadProvider && agent.provider !== leadProvider);
  const title = cross
    ? `Runs on ${agent.provider} (${agent.model}) — a different provider from the chat (${leadProvider})`
    : agent.provider
      ? `${agent.provider} / ${agent.model}`
      : agent.model;
  return (
    <span className={`kraken-act-model${cross ? " is-cross" : ""}`} title={title}>
      {cross ? `${agent.provider} · ${agent.model}` : agent.model}
    </span>
  );
}

/** "3 of 5 tool calls failed" — the degraded-channel caption (P1: a report
 *  resting on a broken tool channel is not evidence, even when it "completed"). */
function degradedCaption(agent: Agent): string {
  const counts =
    agent.toolErrors !== undefined && agent.toolCalls
      ? `${agent.toolErrors} of ${agent.toolCalls} tool calls failed`
      : "most tool calls failed";
  return `Tools degraded: ${counts} — findings unverified`;
}

function AgentRow({
  agent,
  expanded,
  isLead = false,
  leadProvider,
  onToggle,
}: {
  agent: Agent;
  expanded: boolean;
  /** Rows carry a status stripe (§20): same geometry for lead and tentacles,
   *  same click-to-expand — the lead stays accent via .is-lead. */
  isLead?: boolean;
  /** The chat's provider: a tentacle on another one gets a highlighted chip. */
  leadProvider?: string;
  onToggle: () => void;
}) {
  const tools = selectRecentTools(agent, 8);
  const degraded = agent.toolsDegraded === true && agent.status !== "running";
  return (
    <div
      className={`kraken-act-row${expanded ? " is-open" : ""} is-${agent.status ?? "idle"}${isLead ? " is-lead" : ""}${degraded ? " is-degraded" : ""}`}
      onClick={onToggle}
    >
      <div className="kraken-act-line">
        <span className="kraken-act-glyph" aria-hidden>
          {roleGlyph(agent.role)}
        </span>
        <strong className="kraken-act-agent">{agent.title || agent.id}</strong>
        <span className={`kraken-act-status is-${agent.status}`} aria-hidden>
          {statusGlyph(agent.status)}
        </span>
        <span className="kraken-act-dur">
          {formatActivityDuration(
            agent.durationMs ??
              ((agent.status === "running" || agent.status === "waiting" || agent.status === "queued") &&
              agent.startedAt
                ? Date.now() - agent.startedAt
                : undefined),
          )}
        </span>
        <RouteChip agent={agent} leadProvider={leadProvider} />
        <ThinkingChip thinking={agent.thinking} />
        {agent.currentTool ? (
          <span className="kraken-act-tool">· {agent.currentTool}…</span>
        ) : null}
        {agent.phaseMessage ? (
          <span className="kraken-act-phase">· {agent.phaseMessage}</span>
        ) : null}
      </div>
      {agent.status === "failed" && agent.reason ? (
        <div className="kraken-act-reason" title={agent.reason}>
          {agent.reason.length > 180 ? `${agent.reason.slice(0, 177)}…` : agent.reason}
        </div>
      ) : null}
      {degraded ? (
        <div
          className="kraken-act-degraded"
          title="The tentacle finished, but most of its tool calls errored — its report may rest on reads that never happened. Check before relying on it."
        >
          ⚠ {degradedCaption(agent)}
        </div>
      ) : null}
      {expanded ? (
        <div className="kraken-act-details">
          {agent.worktree ? <div>worktree: {shortWorktree(agent.worktree)}</div> : null}
          {agent.graphNodeId ? <div>graph node: {agent.graphNodeId}</div> : null}
          {agent.scope?.length ? <div>scope: {agent.scope.join(", ")}</div> : null}
          {agent.provider && agent.model ? (
            <div>
              model: {agent.provider} / {agent.model}
            </div>
          ) : null}
          {agent.toolCalls !== undefined ? (
            <div>
              tool calls: {agent.toolCalls}
              {agent.toolErrors ? ` (${agent.toolErrors} failed)` : ""}
            </div>
          ) : null}
          {agent.tokenUsage?.output ? <div>output tokens: {agent.tokenUsage.output}</div> : null}
          {tools.length ? (
            <div className="kraken-act-tools">
              {tools.map((t) => (
                <div key={t.id} className="kraken-act-toolrow">
                  <span aria-hidden>{t.status === "failed" ? "✗" : t.status === "completed" ? "✓" : "●"}</span>
                  <span>{t.tool}</span>
                  {t.summary ? <span className="kraken-act-toolsum">{t.summary}</span> : null}
                  {t.durationMs ? (
                    <span className="kraken-act-tooldur">{formatActivityDuration(t.durationMs)}</span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function KrakenActivity({
  conversationId,
  leadProvider,
}: {
  conversationId?: string;
  /** Provider the chat (lead) runs on — tentacles on another one are highlighted. */
  leadProvider?: string;
}) {
  // Scope (M2): the panel renders the activity of ITS conversation only —
  // `conversationId` is both the routing key and the paint key. It does not
  // self-declare as the active chat (that made whichever run was streaming
  // paint here), so two conversations can never share a panel's rows.
  const state = useRunActivity({ conversationId });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** Panel expansion is automatic (t94): open for small runs (≤4 agents) and
   *  whenever any agent is running, collapsed for large quiet runs. A manual
   *  click always wins over the default until the next mount. */
  const [collapsedOverride, setCollapsedOverride] = useState<boolean | null>(null);
  const [, forceTick] = useState(0);
  const lead = selectLead(state);
  const tentacles = selectTentacles(state);
  const counts = selectStatusCounts(state);
  const graph = selectGraphGroups(state);
  const warnings = state.warnings;
  const pending = selectPendingControls(state);
  const hasAgents = state.agentOrder.length > 0;
  const degradedCount = Object.values(state.agents).filter(
    (a) => a.toolsDegraded === true && a.status !== "running",
  ).length;
  const collapsed = collapsedOverride ?? (state.agentOrder.length > 4 && counts.running === 0);

  // 1s ticker while any agent is running (elapsed durations).
  useEffect(() => {
    if (!Object.values(state.agents).some((a) => a.status === "running")) return;
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [state.agents]);

  /** Progress numerator for the header bar: settled = done ∪ failed ∪ cancelled. */
  const settled = counts.completed + counts.failed + counts.cancelled;

  if (!hasAgents) return null;

  return (
    <section className="kraken-act" aria-label="Kraken Activity">
      <button
        type="button"
        className="kraken-act-head"
        aria-expanded={!collapsed}
        onClick={() => setCollapsedOverride(!collapsed)}
      >
        <span className="kraken-act-caret" aria-hidden>
          {collapsed ? "▸" : "▾"}
        </span>
        <span className="kraken-act-title">Kraken activity</span>
        <progress
          className="kraken-act-bar"
          value={settled}
          max={state.agentOrder.length}
          aria-label={`${settled} of ${state.agentOrder.length} agents settled`}
        />
        <span className="kraken-act-counts">
          {settled}/{state.agentOrder.length} done
          {counts.running ? ` · ${counts.running} running` : ""}
          {counts.failed ? ` · ${counts.failed} failed` : ""}
          {degradedCount ? ` · ${degradedCount} degraded` : ""}
          {collapsed && warnings.length ? ` · ⚠ ${warnings.length}` : ""}
        </span>
      </button>
      {collapsed ? null : (
        <div className="kraken-act-body">
          {/* The lead renders through the SAME AgentRow as the tentacles
              (§19): one container, one geometry, same click-to-expand. The
              accent stripe (.is-lead) marks it without shifting content. */}
          {lead || tentacles.length ? (
            <div className="kraken-act-rows">
              {lead ? (
                <AgentRow
                  key={lead.id}
                  agent={lead}
                  isLead
                  leadProvider={leadProvider}
                  expanded={expandedId === lead.id}
                  onToggle={() => setExpandedId(expandedId === lead.id ? null : lead.id)}
                />
              ) : null}
              {tentacles.map((a) => (
                <AgentRow
                  key={a.id}
                  agent={a}
                  leadProvider={leadProvider}
                  expanded={expandedId === a.id}
                  onToggle={() => setExpandedId(expandedId === a.id ? null : a.id)}
                />
              ))}
            </div>
          ) : null}

          {graph.length ? (
            <div className="kraken-act-graph">
              <div className="kraken-act-section">GRAPH</div>
              {graph.map((g) => (
                <div key={g.nodeId} className="kraken-act-graph-row">
                  {g.nodeId}{" "}
                  <span className="kraken-act-muted">
                    ({g.agents.filter((a) => a.status === "completed").length}/{g.agents.length})
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {warnings.length ? (
            <div className="kraken-act-warnings">
              {warnings.slice(-3).map((w, i) => (
                <div
                  key={`${w.agentId}-${i}`}
                  className="kraken-act-warn"
                  title={w.message}
                >
                  ⚠ {w.agentId ? `${w.agentId}: ` : ""}
                  {w.message}
                </div>
              ))}
            </div>
          ) : null}

          {pending.length ? (
            <div className="kraken-act-pending">
              Pending controls: {pending.length} ({pending.map((c) => `${c.type}:${c.state}`).join(", ")})
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
