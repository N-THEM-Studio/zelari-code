/**
 * Selectors over the Kraken Activity state (PHASE 3 §38, §40–44).
 */
import type { ActivityAgent, ActivityToolEvent, RunActivityState } from "./types";

export function selectLead(state: RunActivityState): ActivityAgent | undefined {
  const agents = state.agentOrder.map((id) => state.agents[id]).filter(Boolean);
  return agents.find((a) => a.role === "lead") ?? agents.find((a) => !a.parentId);
}

export function selectTentacles(state: RunActivityState): ActivityAgent[] {
  const lead = selectLead(state);
  return state.agentOrder
    .map((id) => state.agents[id])
    .filter((a): a is ActivityAgent => Boolean(a) && a.id !== lead?.id);
}

export interface StatusCounts {
  running: number;
  queued: number;
  waiting: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export function selectStatusCounts(state: RunActivityState): StatusCounts {
  const counts: StatusCounts = {
    running: 0,
    queued: 0,
    waiting: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const id of state.agentOrder) {
    const a = state.agents[id];
    if (a && a.status in counts) counts[a.status as keyof StatusCounts] += 1;
  }
  return counts;
}

export interface GraphGroup {
  nodeId: string;
  agents: ActivityAgent[];
}

/** Group tentacles by graph node (indented dependency list, §44). */
export function selectGraphGroups(state: RunActivityState): GraphGroup[] {
  const groups = new Map<string, ActivityAgent[]>();
  for (const id of state.agentOrder) {
    const a = state.agents[id];
    if (!a || !a.graphNodeId) continue;
    const list = groups.get(a.graphNodeId) ?? [];
    list.push(a);
    groups.set(a.graphNodeId, list);
  }
  return [...groups.entries()].map(([nodeId, agents]) => ({ nodeId, agents }));
}

export function selectRecentTools(agent: ActivityAgent, n = 8): ActivityToolEvent[] {
  return agent.tools.slice(-n);
}

export function selectPendingControls(state: RunActivityState) {
  return state.controls.filter((c) => c.state !== "applied");
}

export function formatActivityDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "–";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/** Role glyph (§41) — never rely on color alone. */
export function roleGlyph(role: string | undefined): string {
  switch (role) {
    case "lead":
      return "◆";
    case "explore":
      return "⌕";
    case "general":
      return "⌗";
    case "verify":
      return "⊙";
    case "planner":
      return "☑";
    default:
      return "·";
  }
}

export function statusGlyph(status: string | undefined): string {
  switch (status) {
    case "running":
      return "●";
    case "queued":
      return "◌";
    case "waiting":
      return "○";
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "cancelled":
      return "⊘";
    default:
      return "·";
  }
}
