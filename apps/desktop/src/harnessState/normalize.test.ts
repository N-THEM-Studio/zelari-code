import { describe, expect, it } from "vitest";
import { readHarnessStateEvent } from "./normalize";

/**
 * Fixtures mirror the EXACT shapes the CLI derives (src/cli/harnessState.ts,
 * relayed by the sidecar's `harness-state` Tauri event — see
 * apps/desktop/src-tauri/src/harness_sidecar.rs interpret_harness_state).
 */
const REAL_PAYLOAD = {
  type: "harness_state",
  session: { sessionId: "sess-live", status: "completed", startedAt: 1, endedAt: 9, lastSeq: 12 },
  turns: [
    {
      index: 1,
      userText: "fix the bug",
      assistantChars: 42,
      toolCalls: 2,
      toolKinds: ["read_file", "apply_diff"],
      verification: { strict: true, verdict: "PASS" },
      outcome: "completed",
    },
    {
      index: 2,
      toolCalls: 1,
      toolKinds: ["bash"],
      verification: { strict: true, verdict: "BLOCKED" },
      outcome: "completed",
    },
  ],
  execution: {
    turnsTotal: 2,
    contracts: [
      { turn: 1, complete: true, signals: {}, blockers: [] },
      {
        turn: 2,
        complete: false,
        signals: {},
        blockers: ["verification-verdict-BLOCKED"],
      },
    ],
  },
  support: {
    contextProjections: [
      { contextChars: 1200, returnedCount: 4 },
      { contextChars: 800, returnedCount: 2 },
      { occupancy: 0.62, estimatedHistoryTokens: 124000, contextLimit: 200000, policy: "warn" },
    ],
    memoryEvents: 3,
    compactions: 1,
  },
};

describe("readHarnessStateEvent", () => {
  it("normalizes a real payload: turns, verdicts, blockers, support lens", () => {
    const v = readHarnessStateEvent(REAL_PAYLOAD);
    expect(v).not.toBeNull();
    expect(v!.sessionId).toBe("sess-live");
    expect(v!.status).toBe("completed");
    expect(v!.turnsTotal).toBe(2);

    expect(v!.turns[0]).toMatchObject({
      index: 1,
      verdict: "PASS",
      verdictRaw: "PASS",
      complete: true,
      blockers: [],
      toolCalls: 2,
      outcome: "completed",
    });
    expect(v!.turns[1]).toMatchObject({
      index: 2,
      verdict: "BLOCKED",
      complete: false,
      blockers: ["verification-verdict-BLOCKED"],
    });

    expect(v!.support).toEqual({
      contextProjections: 3,
      contextChars: 2000,
      memoryEvents: 3,
      compactions: 1,
      lastOccupancy: 0.62,
      lastPolicy: "warn",
      contextLimit: 200000,
    });
  });

  it("maps REPAIR_REQUIRED and keeps the raw verdict", () => {
    const v = readHarnessStateEvent({
      ...REAL_PAYLOAD,
      turns: [
        {
          index: 1,
          toolCalls: 0,
          verification: { strict: true, verdict: "REPAIR_REQUIRED" },
          outcome: "completed",
        },
      ],
      execution: {
        turnsTotal: 1,
        contracts: [
          { turn: 1, complete: false, signals: {}, blockers: ["verification-verdict-REPAIR_REQUIRED"] },
        ],
      },
    });
    expect(v!.turns[0].verdict).toBe("REPAIR_REQUIRED");
    expect(v!.turns[0].verdictRaw).toBe("REPAIR_REQUIRED");
    expect(v!.turns[0].blockers).toEqual(["verification-verdict-REPAIR_REQUIRED"]);
  });

  it("treats a NON-STRICT PASS as unknown (ADR-0023: unknown ≠ pass)", () => {
    const v = readHarnessStateEvent({
      ...REAL_PAYLOAD,
      turns: [
        {
          index: 1,
          toolCalls: 0,
          verification: { strict: false, verdict: "PASS" },
          outcome: "completed",
        },
      ],
    });
    expect(v!.turns[0].verdict).toBe("unknown");
    expect(v!.turns[0].verdictRaw).toBe("PASS");
  });

  it("falls back to unknown when verification is absent (turn-pending)", () => {
    const v = readHarnessStateEvent({
      type: "harness_state",
      session: { sessionId: "s", status: "pending" },
      turns: [{ index: 1, toolCalls: 0, outcome: "pending" }],
      execution: {
        turnsTotal: 1,
        contracts: [{ turn: 1, complete: false, signals: {}, blockers: ["turn-pending"] }],
      },
      support: { contextProjections: [], memoryEvents: 0, compactions: 0 },
    });
    expect(v!.status).toBe("pending");
    expect(v!.turns[0].verdict).toBe("unknown");
    expect(v!.turns[0].verdictRaw).toBeNull();
    expect(v!.turns[0].outcome).toBe("pending");
    expect(v!.turns[0].blockers).toEqual(["turn-pending"]);
  });

  it("returns null for missing, malformed, or foreign payloads — never throws", () => {
    expect(readHarnessStateEvent(null)).toBeNull();
    expect(readHarnessStateEvent(undefined)).toBeNull();
    expect(readHarnessStateEvent("nonsense")).toBeNull();
    expect(readHarnessStateEvent(42)).toBeNull();
    expect(readHarnessStateEvent({ type: "protocol_info" })).toBeNull();
    // A bare harness_state with no lens fields still normalizes to an EMPTY
    // view (advisory: the panel renders a blank state, no crash).
    const bare = readHarnessStateEvent({ type: "harness_state" });
    expect(bare).toMatchObject({
      sessionId: "",
      status: "pending",
      turnsTotal: 0,
      support: { contextProjections: 0, contextChars: 0, memoryEvents: 0, compactions: 0 },
    });
  });
});
