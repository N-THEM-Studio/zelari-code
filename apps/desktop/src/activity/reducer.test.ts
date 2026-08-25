/**
 * Unit tests for the Kraken Activity reducer + selectors (pure, no DOM).
 */
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../types";
import {
  activityReducer,
  emptyActivityState,
  type ActivityAction,
} from "./reducer";
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
} from "./selectors";

function ev(e: Record<string, unknown>): ActivityAction {
  return { kind: "event", ev: e as AgentEvent };
}

function reduceall(...events: Record<string, unknown>[]) {
  return events.reduce(
    (s, e) => activityReducer(s, ev(e)),
    emptyActivityState(),
  );
}

const SPAWN_LEAD = {
  type: "agent_spawned",
  runId: "run_1",
  agentId: "lead",
  role: "lead",
  model: "model-A",
  provider: "openai",
  ts: 1000,
};

const SPAWN_EXPLORE = {
  type: "agent_spawned",
  runId: "run_1",
  agentId: "exp-1",
  parentAgentId: "lead",
  role: "explore",
  title: "auth architecture",
  model: "model-B",
  scope: ["src/auth/**"],
  graphNodeId: "inspect-auth",
  ts: 2000,
};

describe("activityReducer", () => {
  it("creates agents in arrival order and records runId", () => {
    const s = reduceall(SPAWN_LEAD, SPAWN_EXPLORE);
    expect(s.runId).toBe("run_1");
    expect(s.agentOrder).toEqual(["lead", "exp-1"]);
    expect(s.agents["lead"].model).toBe("model-A");
    expect(s.agents["exp-1"].scope).toEqual(["src/auth/**"]);
    expect(s.agents["exp-1"].graphNodeId).toBe("inspect-auth");
  });

  it("re-spawn patches fields but keeps existing status", () => {
    const s = reduceall(
      SPAWN_EXPLORE,
      { type: "agent_status", agentId: "exp-1", status: "waiting", ts: 2100 },
      { ...SPAWN_EXPLORE, model: "model-C" },
    );
    expect(s.agents["exp-1"].model).toBe("model-C");
    expect(s.agents["exp-1"].status).toBe("waiting");
    expect(s.agentOrder).toEqual(["exp-1"]);
  });

  it("agent_status updates status and failed adds a warning", () => {
    const s = reduceall(
      SPAWN_EXPLORE,
      { type: "agent_status", agentId: "exp-1", status: "failed", message: "boom", ts: 3000 },
    );
    expect(s.agents["exp-1"].status).toBe("failed");
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).toMatchObject({ code: "agent_failed", message: "boom", agentId: "exp-1" });
  });

  it("agent_status for unknown agent creates a defensive shell", () => {
    const s = reduceall({ type: "agent_status", agentId: "ghost", status: "queued" });
    expect(s.agents["ghost"].status).toBe("queued");
  });

  it("agent_tool appends, sets and clears currentTool", () => {
    const s = reduceall(
      SPAWN_EXPLORE,
      { type: "agent_tool", agentId: "exp-1", toolCallId: "t1", tool: "read_file", status: "started", summary: "a.ts", ts: 1 },
      { type: "agent_tool", agentId: "exp-1", toolCallId: "t1", tool: "read_file", status: "completed", durationMs: 12, ts: 2 },
    );
    const a = s.agents["exp-1"];
    expect(a.tools).toHaveLength(2);
    expect(a.tools[1]).toMatchObject({ status: "completed", durationMs: 12 });
    expect(a.currentTool).toBeUndefined();
    const mid = reduceall(
      SPAWN_EXPLORE,
      { type: "agent_tool", agentId: "exp-1", toolCallId: "t1", tool: "read_file", status: "started" },
    );
    expect(mid.agents["exp-1"].currentTool).toBe("read_file");
  });

  it("caps tool history per agent", () => {
    let events: Record<string, unknown>[] = [SPAWN_EXPLORE];
    for (let i = 0; i < 50; i++) {
      events.push({ type: "agent_tool", agentId: "exp-1", toolCallId: `t${i}`, tool: "bash", status: "completed", ts: i });
    }
    const s = reduceall(...events);
    expect(s.agents["exp-1"].tools.length).toBeLessThanOrEqual(40);
    expect(s.agents["exp-1"].tools[s.agents["exp-1"].tools.length - 1].id).toBe("t49");
  });

  it("agent_ended finalizes duration, usage and status", () => {
    const s = reduceall(
      SPAWN_EXPLORE,
      {
        type: "agent_ended",
        agentId: "exp-1",
        reason: "done",
        durationMs: 18000,
        tokenUsage: { input: 100, output: 50 },
        ts: 4000,
      },
    );
    const a = s.agents["exp-1"];
    expect(a.status).toBe("completed");
    expect(a.durationMs).toBe(18000);
    expect(a.tokenUsage).toEqual({ input: 100, output: 50 });
    expect(a.currentTool).toBeUndefined();
  });

  it("agent_ended preserves failed/cancelled status", () => {
    const s = reduceall(
      SPAWN_EXPLORE,
      { type: "agent_status", agentId: "exp-1", status: "cancelled" },
      { type: "agent_ended", agentId: "exp-1", reason: "cancelled", durationMs: 10 },
    );
    expect(s.agents["exp-1"].status).toBe("cancelled");
  });

  it("control lifecycle accepted -> applied with boundary", () => {
    const s = reduceall(
      { type: "control_accepted", controlId: "c1", controlType: "steer" },
      { type: "control_applied", controlId: "c1", controlType: "steer", boundary: "turn-end" },
    );
    expect(s.controls).toHaveLength(1);
    expect(s.controls[0]).toMatchObject({ id: "c1", state: "applied", boundary: "turn-end" });
    expect(selectPendingControls(s)).toHaveLength(0);
  });

  it("control_rejected for unknown id is recorded", () => {
    const s = reduceall({ type: "control_rejected", controlId: "cx", reason: "bad" });
    expect(s.controls[0]).toMatchObject({ id: "cx", state: "rejected", reason: "bad" });
  });

  it("ignores unrelated event types", () => {
    const s = reduceall({ type: "log", message: "hi" }, { type: "message_delta", delta: "x" });
    expect(s.agentOrder).toEqual([]);
    expect(s.warnings).toEqual([]);
  });

  it("reset empties the state", () => {
    const s = reduceall(SPAWN_LEAD);
    const r = activityReducer(s, { kind: "reset" });
    expect(r).toEqual(emptyActivityState());
  });
});

describe("activity selectors", () => {
  const state = reduceall(
    SPAWN_LEAD,
    SPAWN_EXPLORE,
    { type: "agent_spawned", runId: "run_1", agentId: "gen-1", parentAgentId: "lead", role: "general", graphNodeId: "impl", ts: 3 },
    { type: "agent_spawned", runId: "run_1", agentId: "ver-1", parentAgentId: "lead", role: "verify", graphNodeId: "impl", ts: 4 },
    { type: "agent_status", agentId: "gen-1", status: "completed" },
    { type: "agent_status", agentId: "ver-1", status: "queued" },
  );

  it("selectLead prefers role lead; tentacles exclude it", () => {
    expect(selectLead(state)?.id).toBe("lead");
    expect(selectTentacles(state).map((a) => a.id)).toEqual(["exp-1", "gen-1", "ver-1"]);
  });

  it("selectStatusCounts tallies statuses", () => {
    expect(selectStatusCounts(state)).toEqual({
      running: 2,
      queued: 1,
      waiting: 0,
      completed: 1,
      failed: 0,
      cancelled: 0,
    });
  });

  it("selectGraphGroups groups by graphNodeId", () => {
    const groups = selectGraphGroups(state);
    const impl = groups.find((g) => g.nodeId === "impl");
    expect(impl?.agents.map((a) => a.role).sort()).toEqual(["general", "verify"]);
    expect(groups.find((g) => g.nodeId === "inspect-auth")?.agents).toHaveLength(1);
  });

  it("glyph + duration helpers", () => {
    expect(roleGlyph("lead")).toBe("◆");
    expect(roleGlyph("verify")).toBe("⊙");
    expect(statusGlyph("running")).toBe("●");
    expect(statusGlyph("failed")).toBe("✗");
    expect(formatActivityDuration(undefined)).toBe("–");
    expect(formatActivityDuration(83000)).toBe("1m 23s");
    expect(formatActivityDuration(5000)).toBe("5s");
  });

  it("selectRecentTools returns the tail", () => {
    const s = reduceall(SPAWN_EXPLORE, ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => ({
      type: "agent_tool",
      agentId: "exp-1",
      toolCallId: `t${i}`,
      tool: "bash",
      status: "completed" as const,
      ts: i,
    })));
    const tail = selectRecentTools(s.agents["exp-1"], 3);
    expect(tail.map((t) => t.id)).toEqual(["t8", "t9", "t10"]);
  });
});
