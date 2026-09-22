/**
 * Pure reducer for the Kraken Activity panel (PHASE 3 §38).
 *
 * Consumes enveloped AgentEvents (already stripped of the Tauri envelope
 * by `onAgentEvent`); never performs IO, never reads the clock — all
 * timestamps come from the events themselves.
 */
import type { AgentEvent } from "../types";
import { classifyVerifyCaption } from "../components/tentacleVerdict";
import {
  ACTIVITY_STATUSES,
  MAX_CONTROLS,
  MAX_TOOLS_PER_AGENT,
  MAX_WARNINGS,
  type ActivityAgent,
  type ActivityAgentStatus,
  type ActivityToolEvent,
  type RunActivityState,
} from "./types";

export function emptyActivityState(): RunActivityState {
  return { agentOrder: [], agents: {}, warnings: [], controls: [] };
}

const HOST_CANCEL_CODES = new Set([
  "turn_timeout",
  "turn_idle_timeout",
  "turn_wall_timeout",
  "cancelled",
]);

function isHostCancel(ev: Record<string, unknown>): boolean {
  if (ev.type === "error") {
    const code = typeof ev.code === "string" ? ev.code : "";
    return HOST_CANCEL_CODES.has(code) || ev.severity === "cancelled";
  }
  return ev.type === "agent_end" && ev.reason === "cancelled";
}

/** Parent turn died (watchdog or Stop) without agent_ended for in-flight tentacles. */
function sealOpenAgents(
  state: RunActivityState,
  ev: Record<string, unknown>,
): RunActivityState {
  const ts = typeof ev.ts === "number" ? ev.ts : undefined;
  const reason =
    typeof ev.message === "string"
      ? ev.message
      : typeof ev.reason === "string"
        ? ev.reason
        : "cancelled";
  let changed = false;
  const agents = { ...state.agents };
  for (const id of state.agentOrder) {
    const agent = agents[id];
    if (!agent) continue;
    if (agent.status === "completed" || agent.status === "failed" || agent.status === "cancelled") {
      continue;
    }
    changed = true;
    const endedAt = ts ?? agent.endedAt;
    const durationMs =
      agent.durationMs ??
      (typeof endedAt === "number" && typeof agent.startedAt === "number" && agent.startedAt > 0
        ? Math.max(0, endedAt - agent.startedAt)
        : undefined);
    agents[id] = {
      ...agent,
      status: "cancelled",
      endedAt,
      durationMs,
      reason: agent.reason ?? reason,
      currentTool: undefined,
    };
  }
  return changed ? { ...state, agents } : state;
}

export type ActivityAction =
  | { kind: "event"; ev: AgentEvent }
  | { kind: "reset" };

function isActivityStatus(v: unknown): v is ActivityAgentStatus {
  return typeof v === "string" && (ACTIVITY_STATUSES as readonly string[]).includes(v);
}

function upsertAgent(
  state: RunActivityState,
  agentId: string,
  patch: (agent: ActivityAgent) => ActivityAgent,
  create: () => ActivityAgent,
): RunActivityState {
  const existing = state.agents[agentId];
  const next = existing ? patch(existing) : create();
  const agents = { ...state.agents, [agentId]: next };
  const agentOrder = existing ? state.agentOrder : [...state.agentOrder, agentId];
  return { ...state, agents, agentOrder };
}

function appendTool(agent: ActivityAgent, tool: ActivityToolEvent): ActivityAgent {
  const tools = [...agent.tools, tool];
  if (tools.length > MAX_TOOLS_PER_AGENT) {
    tools.splice(0, tools.length - MAX_TOOLS_PER_AGENT);
  }
  return { ...agent, tools };
}

/** Reduce one AgentEvent into the activity state. Unknown types are ignored. */
export function activityReducer(
  state: RunActivityState,
  action: ActivityAction,
): RunActivityState {
  if (action.kind === "reset") return emptyActivityState();
  const ev = action.ev as Record<string, unknown>;
  const type = ev.type;

  if (type === "agent_spawned") {
    const agentId = typeof ev.agentId === "string" ? ev.agentId : "";
    if (!agentId) return state;
    const runId = typeof ev.runId === "string" ? ev.runId : state.runId;
    const next = upsertAgent(
      state,
      agentId,
      (a) => ({
        ...a,
        parentId: typeof ev.parentAgentId === "string" ? ev.parentAgentId : a.parentId,
        role: typeof ev.role === "string" ? ev.role : a.role,
        title: typeof ev.title === "string" ? ev.title : a.title,
        model: typeof ev.model === "string" ? ev.model : a.model,
        provider: typeof ev.provider === "string" ? ev.provider : a.provider,
        // Per-tentacle thinking effort actually applied (ADR-0017); absent on
        // spawns that never reported one, so a re-spawn without it keeps the
        // previous value rather than blanking the chip.
        thinking: typeof ev.thinking === "string" ? ev.thinking : a.thinking,
        scope: Array.isArray(ev.scope) ? (ev.scope as string[]) : a.scope,
        graphNodeId: typeof ev.graphNodeId === "string" ? ev.graphNodeId : a.graphNodeId,
        worktree: typeof ev.worktree === "string" ? ev.worktree : a.worktree,
        // Status is owned by agent_status events; a re-spawn only refreshes metadata.
      }),
      () => ({
        id: agentId,
        parentId: typeof ev.parentAgentId === "string" ? ev.parentAgentId : undefined,
        role: typeof ev.role === "string" ? ev.role : "general",
        title: typeof ev.title === "string" ? ev.title : undefined,
        model: typeof ev.model === "string" ? ev.model : undefined,
        provider: typeof ev.provider === "string" ? ev.provider : undefined,
        thinking: typeof ev.thinking === "string" ? ev.thinking : undefined,
        status: "running",
        startedAt: typeof ev.ts === "number" ? ev.ts : 0,
        scope: Array.isArray(ev.scope) ? (ev.scope as string[]) : undefined,
        graphNodeId: typeof ev.graphNodeId === "string" ? ev.graphNodeId : undefined,
        worktree: typeof ev.worktree === "string" ? ev.worktree : undefined,
        tools: [],
      }),
    );
    return runId === state.runId ? next : { ...next, runId };
  }

  if (type === "agent_status") {
    const agentId = typeof ev.agentId === "string" ? ev.agentId : "";
    if (!agentId) return state;
    const status = isActivityStatus(ev.status) ? ev.status : undefined;
    const message = typeof ev.message === "string" ? ev.message : undefined;
    // Contract (ADR-0023, "unknown ≠ pass"): an EXACT 'verify PASS' caption is a
    // terminal PASS verdict. When it arrives without a terminal status (older
    // CLI, or the caption outliving the row's status) a running general would
    // otherwise stay ● running forever. Discipline: only the exact PASS token
    // flips anything, and an explicit valid non-running status always wins.
    const current = state.agents[agentId];
    const captionCompleted =
      message !== undefined &&
      classifyVerifyCaption(message) === "PASS" &&
      (status === undefined || status === "running") &&
      (current === undefined || current.status === "running");
    let next = upsertAgent(
      state,
      agentId,
      (a) => ({
        ...a,
        status: captionCompleted ? "completed" : status ?? a.status,
        // t94: persist the phase caption (previously dropped unless failed).
        phaseMessage: message ?? a.phaseMessage,
      }),
      () => ({
        id: agentId,
        role: "general",
        status: captionCompleted ? "completed" : status ?? "running",
        phaseMessage: message,
        tools: [],
      }),
    );
    if (status === "failed" && message) {
      const warnings = [
        ...next.warnings,
        {
          code: "agent_failed",
          message,
          agentId,
          ts: typeof ev.ts === "number" ? ev.ts : undefined,
        },
      ];
      if (warnings.length > MAX_WARNINGS) {
        warnings.splice(0, warnings.length - MAX_WARNINGS);
      }
      next = { ...next, warnings };
    }
    return next;
  }

  if (type === "agent_tool") {
    const agentId = typeof ev.agentId === "string" ? ev.agentId : "";
    if (!agentId) return state;
    const tool = typeof ev.tool === "string" ? ev.tool : "unknown";
    const rawStatus = typeof ev.status === "string" ? ev.status : "started";
    const toolStatus: ActivityToolEvent["status"] =
      rawStatus === "completed" || rawStatus === "failed" ? rawStatus : "started";
    const toolId =
      typeof ev.toolCallId === "string" && ev.toolCallId
        ? ev.toolCallId
        : `${tool}-${typeof ev.ts === "number" ? ev.ts : nextCounter()}`;
    const toolEvent: ActivityToolEvent = {
      id: toolId,
      tool,
      status: toolStatus,
      summary: typeof ev.summary === "string" ? ev.summary : undefined,
      durationMs: typeof ev.durationMs === "number" ? ev.durationMs : undefined,
      ts: typeof ev.ts === "number" ? ev.ts : undefined,
    };
    return upsertAgent(
      state,
      agentId,
      (a) => ({
        ...appendTool(a, toolEvent),
        currentTool: toolStatus === "started" ? tool : undefined,
      }),
      () => ({
        id: agentId,
        role: "general",
        status: "running",
        tools: [toolEvent],
        currentTool: toolStatus === "started" ? tool : undefined,
      }),
    );
  }

  if (type === "agent_ended") {
    const agentId = typeof ev.agentId === "string" ? ev.agentId : "";
    if (!agentId) return state;
    return upsertAgent(
      state,
      agentId,
      (a) => ({
        ...a,
        endedAt: typeof ev.ts === "number" ? ev.ts : a.endedAt,
        durationMs: typeof ev.durationMs === "number" ? ev.durationMs : a.durationMs,
        reason: typeof ev.reason === "string" ? ev.reason : a.reason,
        tokenUsage:
          ev.tokenUsage && typeof ev.tokenUsage === "object"
            ? (ev.tokenUsage as { input?: number; output?: number })
            : a.tokenUsage,
        status:
          a.status === "failed" || a.status === "cancelled"
            ? a.status
            : // t102: an explicit `ok` boolean decides, full stop. A successful
              // tentacle whose RESULT text mentions "denied"/"failed"/"error"
              // (it may have researched exactly those) must stay completed —
              // the reason regex is only the legacy fallback for events with
              // no boolean at all (unknown ≠ failed).
              ev.ok === true
              ? "completed"
              : ev.ok === false ||
                  (typeof ev.reason === "string" &&
                    /fail|error|denied|cancel/i.test(ev.reason))
                ? "failed"
                : "completed",
        currentTool: undefined,
      }),
      () => ({ id: agentId, role: "general", status: "completed", tools: [] }),
    );
  }

  if (type === "control_accepted" || type === "control_rejected") {
    const controlId = typeof ev.controlId === "string" && ev.controlId ? ev.controlId : "";
    if (!controlId) return state;
    const existing = state.controls.find((c) => c.id === controlId);
    if (existing) {
      return {
        ...state,
        controls: state.controls.map((c) =>
          c.id === controlId
            ? {
                ...c,
                state: type === "control_accepted" ? "accepted" : "rejected",
                reason: typeof ev.reason === "string" ? ev.reason : undefined,
              }
            : c,
        ),
      };
    }
    const controls = [
      ...state.controls,
      {
        id: controlId,
        type:
          typeof ev.controlType === "string" && ev.controlType
            ? ev.controlType
            : type.replace("control_", ""),
        state: type === "control_accepted" ? ("accepted" as const) : ("rejected" as const),
        reason: typeof ev.reason === "string" ? ev.reason : undefined,
      },
    ];
    if (controls.length > MAX_CONTROLS) {
      controls.splice(0, controls.length - MAX_CONTROLS);
    }
    return { ...state, controls };
  }

  if (type === "control_applied") {
    const controlId = typeof ev.controlId === "string" && ev.controlId ? ev.controlId : "";
    if (!controlId) return state;
    const exists = state.controls.some((c) => c.id === controlId);
    const controls = exists
      ? state.controls.map((c) =>
          c.id === controlId
            ? {
                ...c,
                state: "applied" as const,
                boundary: typeof ev.boundary === "string" ? ev.boundary : undefined,
              }
            : c,
        )
      : [
          ...state.controls,
          {
            id: controlId,
            type:
              typeof ev.controlType === "string" && ev.controlType
                ? ev.controlType
                : "unknown",
            state: "applied" as const,
            boundary: typeof ev.boundary === "string" ? ev.boundary : undefined,
          },
        ];
    return { ...state, controls };
  }

  if (isHostCancel(ev)) {
    return sealOpenAgents(state, ev);
  }

  return state;
}

/** Monotonic fallback id source for tool events without toolCallId. */
let toolFallbackCounter = 0;
function nextCounter(): number {
  toolFallbackCounter += 1;
  return toolFallbackCounter;
}
