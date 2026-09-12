// @vitest-environment jsdom
/**
 * Regression tests — Kraken Activity conversation isolation (M2).
 *
 * Bug: useRunActivity() reduced the GLOBAL `agent-event` stream, so a run
 * in chat A painted its tentacles into chat B's Kraken Activity panel (and
 * the sidebar mission tree). The fix filters events through their run
 * envelope (`readRunEnvelope().conversationId`), threaded from App as the
 * `conversationId` prop. Tested through the REAL KrakenActivity component:
 * unlike the Sidebar/TentacleTracePanel suites, this is the first test that
 * actually EXECUTES the hook under jsdom.
 */
import { cleanup, render, screen, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../types";

// Two-React guard: apps/desktop has its own node_modules copy of React
// (npm --prefix install) while @testing-library/react at the root uses the
// root copy — two Reacts in one module graph break hooks (dispatcher null).
// Same pin as Sidebar.test.tsx / LiveTasksPanel.test.tsx.
vi.mock("react", async () => {
  // @ts-expect-error tsc: importing the runtime entry loses type info by design
  return await import("../../../../node_modules/react/index.js");
});

vi.mock("../agentClient", () => ({
  onAgentEvent: vi.fn(async () => () => {}),
}));

import { onAgentEvent } from "../agentClient";
import { clearActivityStoreForTests } from "./useRunActivity";
import { KrakenActivity } from "../components/KrakenActivity";

type Handler = (event: AgentEvent) => void;

let handlers: Handler[] = [];

function armMock(): void {
  vi.mocked(onAgentEvent).mockImplementation(async (h) => {
    handlers.push(h);
    return () => {
      const i = handlers.indexOf(h);
      if (i >= 0) handlers.splice(i, 1);
    };
  });
}

function emit(ev: unknown): void {
  act(() => {
    for (const h of handlers) h(ev as unknown as AgentEvent);
  });
}

const SPAWN_A = {
  type: "agent_spawned",
  conversationId: "conv-A",
  runId: "run-A",
  agentId: "a-lead",
  role: "lead",
  title: "Project A lead",
  ts: 1,
};
const SPAWN_B = {
  type: "agent_spawned",
  conversationId: "conv-B",
  runId: "run-B",
  agentId: "b-lead",
  role: "lead",
  title: "Project B lead",
  ts: 2,
};
const SPAWN_LEGACY = {
  // No conversationId envelope: un-attributable (legacy emitter).
  type: "agent_spawned",
  runId: "run-L",
  agentId: "l-lead",
  role: "lead",
  title: "Legacy lead",
  ts: 3,
};

afterEach(cleanup);

describe("KrakenActivity — conversation isolation (M2)", () => {
  beforeEach(() => {
    handlers = [];
    vi.mocked(onAgentEvent).mockReset();
    // The accumulation store is module-level (it must survive conversation
    // switches in the app) — wipe it so tests start from a clean slate.
    clearActivityStoreForTests();
  });

  it("envelope-tagged events from another conversation never reach the panel", () => {
    armMock();
    render(<KrakenActivity conversationId="conv-B" />);
    emit(SPAWN_A);
    emit(SPAWN_B);
    expect(screen.getByText("Project B lead")).toBeTruthy();
    expect(screen.queryByText("Project A lead")).toBeNull();
  });

  it("status events from another conversation do not touch this panel's agents", () => {
    armMock();
    render(<KrakenActivity conversationId="conv-B" />);
    emit(SPAWN_B);
    emit({
      type: "agent_status",
      conversationId: "conv-A",
      runId: "run-A",
      agentId: "b-lead", // same agent id reused by the other run
      status: "failed",
      message: "boom in chat A",
      ts: 4,
    });
    // Cross-conversation status with a colliding agentId must NOT corrupt
    // this panel's row (failed glyph/warning would show if leaked).
    expect(screen.getByText("Project B lead")).toBeTruthy();
    expect(screen.queryByText(/boom in chat A/)).toBeNull();
  });

  it("un-enveloped (legacy) events still flow to the active conversation's panel", () => {
    armMock();
    // The panel mounts only in the active conversation's view, so its
    // conversation IS the active one: un-attributable events are accepted.
    render(<KrakenActivity conversationId="conv-B" />);
    emit(SPAWN_LEGACY);
    expect(screen.getByText("Legacy lead")).toBeTruthy();
  });

  it("without a conversationId prop the panel keeps the previous unfiltered behavior", () => {
    armMock();
    render(<KrakenActivity />);
    emit(SPAWN_A);
    emit(SPAWN_B);
    expect(screen.getByText("Project A lead")).toBeTruthy();
    expect(screen.getByText("Project B lead")).toBeTruthy();
  });

  it("switching conversation resets the tree (live view, not history)", () => {
    armMock();
    const { rerender } = render(<KrakenActivity conversationId="conv-B" />);
    emit(SPAWN_B);
    expect(screen.getByText("Project B lead")).toBeTruthy();

    rerender(<KrakenActivity conversationId="conv-C" />);
    expect(screen.queryByText("Project B lead")).toBeNull();
    // Empty tree = inert panel by design ("renders nothing until an
    // agent_spawned arrives"): the reset IS the absence of stale rows.
    expect(screen.queryByText("KRAKEN ACTIVITY")).toBeNull();
  });

  it("switching BACK to a running conversation restores titles and statuses (no skeleton rows)", () => {
    armMock();
    const { rerender } = render(<KrakenActivity conversationId="conv-A" />);
    emit(SPAWN_A);
    emit({
      type: "agent_spawned",
      conversationId: "conv-A",
      runId: "run-A",
      agentId: "a-t1",
      parentAgentId: "a-lead",
      role: "explore",
      title: "Map auth flow",
      ts: 5,
    });
    expect(screen.getByText("Map auth flow")).toBeTruthy();

    // Switch away, then back: the tree must come back WITH metadata from
    // the accumulation store — not as bare agent-id stubs rebuilt from
    // late ticks (the 2026-09-13 regression: "t1 ● – · reasoning").
    rerender(<KrakenActivity conversationId="conv-B" />);
    expect(screen.queryByText("Map auth flow")).toBeNull();
    rerender(<KrakenActivity conversationId="conv-A" />);
    expect(screen.getByText("Project A lead")).toBeTruthy();
    expect(screen.getByText("Map auth flow")).toBeTruthy();
  });

  it("background runs keep accumulating while another conversation is active", () => {
    armMock();
    const { rerender } = render(<KrakenActivity conversationId="conv-B" />);
    // conv-A's run progresses while conv-B is the active panel.
    emit(SPAWN_A);
    emit({
      type: "agent_status",
      conversationId: "conv-A",
      runId: "run-A",
      agentId: "a-lead",
      status: "failed",
      message: "boom in chat A",
      ts: 6,
    });
    expect(screen.queryByText(/boom in chat A/)).toBeNull(); // not painted here

    rerender(<KrakenActivity conversationId="conv-A" />);
    expect(screen.getByText("Project A lead")).toBeTruthy();
    expect(screen.getByText(/boom in chat A/)).toBeTruthy(); // accumulated, not lost
  });

  it("a new mission in the same conversation starts from an empty tree", () => {
    armMock();
    const { rerender } = render(<KrakenActivity conversationId="conv-A" />);
    emit(SPAWN_A);
    expect(screen.getByText("Project A lead")).toBeTruthy();

    rerender(<KrakenActivity conversationId="conv-B" />);
    rerender(<KrakenActivity conversationId="conv-A" />);
    // Second run in the SAME conversation: different runId wipes the
    // previous mission's agents instead of merging with them.
    emit({
      type: "agent_spawned",
      conversationId: "conv-A",
      runId: "run-A2",
      agentId: "a-lead-2",
      role: "lead",
      title: "Project A v2 lead",
      ts: 7,
    });
    expect(screen.getByText("Project A v2 lead")).toBeTruthy();
    expect(screen.queryByText("Project A lead")).toBeNull();
  });
});

describe("KrakenActivity — per-tentacle thinking chip (ADR-0017)", () => {
  beforeEach(() => {
    handlers = [];
    vi.mocked(onAgentEvent).mockReset();
    clearActivityStoreForTests();
  });

  const SPAWN_T = {
    type: "agent_spawned",
    conversationId: "conv-T",
    runId: "run-T",
    agentId: "t-explore",
    parentAgentId: "t-lead",
    role: "explore",
    title: "Map auth flow",
    model: "grok-4",
    ts: 11,
  };
  const SPAWN_T_LEAD = {
    ...SPAWN_T,
    agentId: "t-lead",
    parentAgentId: undefined,
    role: "lead",
    title: "Lead",
  };

  it("shows the applied effort next to the model when the spawn reported one", () => {
    armMock();
    render(<KrakenActivity conversationId="conv-T" />);
    emit({ ...SPAWN_T_LEAD, thinking: "high" });
    emit({ ...SPAWN_T, thinking: "medium" });

    expect(screen.getAllByText(/^effort: /)).toHaveLength(2);
    expect(screen.getByText("effort: high")).toBeTruthy();
    expect(screen.getByText("effort: medium")).toBeTruthy();
  });

  it("hides the chip for auto, inherit and absent thinking", () => {
    armMock();
    render(<KrakenActivity conversationId="conv-T" />);
    emit({ ...SPAWN_T_LEAD, thinking: "auto" });
    emit({ ...SPAWN_T, thinking: "high" });
    emit({
      ...SPAWN_T,
      agentId: "t-inherit",
      role: "general",
      title: "Inherited",
      thinking: "inherit",
    });
    emit({
      ...SPAWN_T,
      agentId: "t-absent",
      role: "verify",
      title: "No effort",
      thinking: undefined,
    });

    // Only the explicit 'high' tentacle wears a chip.
    expect(screen.getAllByText(/^effort: /)).toHaveLength(1);
    expect(screen.getByText("effort: high")).toBeTruthy();
  });
});
