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
});
