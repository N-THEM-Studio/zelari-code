// @vitest-environment jsdom
/**
 * SLICE7(run-activity-batching) — the Kraken activity tree is PAINTED through
 * the shared coalescing holder instead of a plain `useState`.
 *
 * Bug being locked down: `agent-event` is the busiest stream of a run (spawns,
 * status ticks, tool starts/ends) and App consumes this same hook, so every
 * single event committed the whole ~4000-line app once — the last per-event
 * re-render left after the sidecar slices were batched.
 *
 * What must hold after batching:
 *  1. a burst of activity events paints ONCE, not once per event;
 *  2. the settled tree is complete and identical to the store's accumulation
 *     and to a plain reducer replay of the same sequence (merge, never drop) —
 *     including the new-mission-in-the-same-conversation reset;
 *  3. a run boundary (`flushSidecarBatches()`, which App calls on
 *     message_end / agent_end / run-finished) lands the tree with no timer
 *     wait;
 *  4. a continuous stream still paints every window (throttle, not debounce);
 *  5. a conversation switch hydrates immediately — navigation is never batched
 *     late.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../types";

// Two-React guard: apps/desktop has its own node_modules copy of React
// (npm --prefix install) while @testing-library/react at the root uses the
// root copy — two Reacts in one module graph break hooks (dispatcher null).
// Same pin as useRunActivity.test.tsx / useSidecarBatch.test.tsx.
vi.mock("react", async () => {
  // @ts-expect-error tsc: importing the runtime entry loses type info by design
  return await import("../../../../node_modules/react/index.js");
});

vi.mock("../agentClient", () => ({
  onAgentEvent: vi.fn(async () => () => {}),
}));

import { onAgentEvent } from "../agentClient";
import { SIDECAR_BATCH_MS, flushSidecarBatches } from "../hooks/useSidecarBatch";
import { activityReducer, emptyActivityState, type ActivityAction } from "./reducer";
import type { RunActivityState } from "./types";
import {
  clearActivityStoreForTests,
  readActivityStoreForTests,
  useRunActivity,
} from "./useRunActivity";

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

function dispatch(ev: unknown): void {
  for (const h of handlers) h(ev as unknown as AgentEvent);
}

const CONV = "conv-run";
const OTHER = "conv-other";
const RUN = "run-1";
const TENTACLES = 10;

/**
 * One realistic Kraken burst: a lead spawn, then per tentacle a spawn + tool
 * start + status tick + tool end; the last tentacle fails (warning) and the
 * first one settles. 51 events in total.
 */
function burstEvents(): unknown[] {
  const events: unknown[] = [
    {
      type: "agent_spawned",
      conversationId: CONV,
      runId: RUN,
      agentId: "t-lead",
      role: "lead",
      title: "Lead",
      model: "grok-4",
      ts: 1,
    },
  ];
  for (let i = 0; i < TENTACLES; i += 1) {
    const agentId = `t-${i}`;
    events.push(
      {
        type: "agent_spawned",
        conversationId: CONV,
        runId: RUN,
        agentId,
        parentAgentId: "t-lead",
        role: "general",
        title: `Tentacle ${i}`,
        model: "grok-4",
        thinking: "high",
        ts: 10 + i,
      },
      {
        type: "agent_tool",
        conversationId: CONV,
        runId: RUN,
        agentId,
        tool: "read_file",
        status: "started",
        toolCallId: `c-${i}`,
        ts: 20 + i,
      },
      {
        type: "agent_status",
        conversationId: CONV,
        runId: RUN,
        agentId,
        status: "running",
        message: `step ${i}`,
        ts: 30 + i,
      },
      {
        type: "agent_tool",
        conversationId: CONV,
        runId: RUN,
        agentId,
        tool: "read_file",
        status: "completed",
        toolCallId: `c-${i}`,
        durationMs: 12,
        ts: 40 + i,
      },
    );
    if (i === 0) {
      events.push({
        type: "agent_ended",
        conversationId: CONV,
        runId: RUN,
        agentId,
        ok: true,
        durationMs: 900,
        ts: 50,
      });
    }
  }
  events.push({
    type: "agent_status",
    conversationId: CONV,
    runId: RUN,
    agentId: "t-9",
    status: "failed",
    message: "boom in tentacle 9",
    ts: 60,
  });
  return events;
}

/**
 * Un-batched reference: the module store's own rule (reduce every event, in
 * arrival order, resetting the tree when a new mission starts in the same
 * conversation) applied without any paint batching.
 */
function referenceReplay(events: unknown[]): RunActivityState {
  let state = emptyActivityState();
  for (const ev of events) {
    const rec = ev as Record<string, unknown>;
    if (
      rec.type === "agent_spawned" &&
      typeof rec.runId === "string" &&
      state.runId !== undefined &&
      state.runId !== rec.runId
    ) {
      state = emptyActivityState();
    }
    state = activityReducer(state, { kind: "event", ev } as ActivityAction);
  }
  return state;
}

/** Renders of the harness component, mount excluded. */
let renders = 0;
/** The tree the hook last handed to its consumer. */
let painted: RunActivityState = emptyActivityState();

/** Mount the hook's consumer; the returned callback switches conversation. */
function mountActivity(conversationId: string): (next: string) => void {
  function View({ conversationId }: { conversationId: string }) {
    const state = useRunActivity({ conversationId });
    renders += 1;
    painted = state;
    return null;
  }
  const utils = render(<View conversationId={conversationId} />);
  renders = 0; // the mount commit is not what we are counting
  return (next: string) => utils.rerender(<View conversationId={next} />);
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  handlers = [];
  vi.mocked(onAgentEvent).mockReset();
  clearActivityStoreForTests();
  vi.useFakeTimers();
});

describe("useRunActivity — batched paint (SLICE7)", () => {
  it("coalesces a burst into ONE commit and settles on the complete tree", () => {
    armMock();
    mountActivity(CONV);
    const events = burstEvents();

    act(() => {
      for (const ev of events) dispatch(ev);
    });
    // 51 events inside the window: not a single App commit yet.
    expect(renders).toBe(0);
    expect(painted.agentOrder).toHaveLength(0);

    // App's run-finished / agent_end path: land the batch, no timer wait.
    act(() => {
      flushSidecarBatches();
    });
    expect(renders).toBe(1);

    const settled = painted;
    expect(settled.runId).toBe(RUN);
    expect(settled.agentOrder).toHaveLength(TENTACLES + 1);
    expect(settled.agents["t-4"]?.title).toBe("Tentacle 4");
    expect(settled.agents["t-4"]?.tools.map((t) => t.status)).toEqual([
      "started",
      "completed",
    ]);
    expect(settled.agents["t-0"]?.status).toBe("completed");
    expect(settled.agents["t-9"]?.status).toBe("failed");
    expect(settled.warnings).toHaveLength(1);
    // Nothing was dropped: the painted tree IS the accumulated store, and both
    // are exactly what an un-batched replay of the same sequence produces.
    expect(readActivityStoreForTests(CONV)).toEqual(settled);
    expect(settled).toEqual(referenceReplay(events));
  });

  it("keeps the tree complete across a mission boundary in the same conversation", () => {
    armMock();
    mountActivity(CONV);
    const events = burstEvents();
    act(() => {
      for (const ev of events) dispatch(ev);
    });
    act(() => {
      flushSidecarBatches();
    });
    expect(painted.agentOrder).toHaveLength(TENTACLES + 1);

    // A second mission (new runId) in the SAME conversation: the whole burst
    // below must land, and the reset semantics must survive batching.
    const secondMission = [
      {
        type: "agent_spawned",
        conversationId: CONV,
        runId: "run-2",
        agentId: "n-lead",
        role: "lead",
        title: "Second mission lead",
        ts: 100,
      },
      {
        type: "agent_status",
        conversationId: CONV,
        runId: "run-2",
        agentId: "n-lead",
        status: "running",
        message: "planning",
        ts: 101,
      },
    ];
    act(() => {
      for (const ev of secondMission) dispatch(ev);
    });
    act(() => {
      flushSidecarBatches();
    });

    expect(painted.runId).toBe("run-2");
    expect(painted.agentOrder).toEqual(["n-lead"]);
    expect(painted).toEqual(referenceReplay([...events, ...secondMission]));
  });

  it("paints every window on a continuous stream (throttle, not debounce)", () => {
    armMock();
    mountActivity(CONV);
    act(() => {
      for (const ev of burstEvents()) dispatch(ev);
    });
    expect(renders).toBe(0);

    // No boundary flush here: the window itself must land the pending batch.
    act(() => {
      vi.advanceTimersByTime(SIDECAR_BATCH_MS);
    });
    expect(renders).toBe(1);
    expect(painted.agentOrder).toHaveLength(TENTACLES + 1);

    // More ticks in the next window: a second commit, not a starved queue.
    act(() => {
      dispatch({
        type: "agent_status",
        conversationId: CONV,
        runId: RUN,
        agentId: "t-2",
        status: "completed",
        ts: 200,
      });
      vi.advanceTimersByTime(SIDECAR_BATCH_MS);
    });
    expect(renders).toBe(2);
    expect(painted.agents["t-2"]?.status).toBe("completed");
  });

  it("hydrates a conversation switch immediately (navigation is never batched late)", () => {
    armMock();
    const show = mountActivity(OTHER);
    act(() => {
      for (const ev of burstEvents()) dispatch(ev);
    });
    // The burst belonged to CONV: this panel paints nothing and stays quiet.
    expect(renders).toBe(0);
    expect(painted.agentOrder).toHaveLength(0);

    show(CONV); // user opens the chat that was running in the background
    // Hydrated by the switch itself — no flush call, no timer wait.
    expect(painted.agentOrder).toHaveLength(TENTACLES + 1);
    expect(painted.agents["t-lead"]?.title).toBe("Lead");
    // And nothing is left queued: no ghost batch paints a stale frame later.
    const afterSwitch = renders;
    act(() => {
      vi.advanceTimersByTime(SIDECAR_BATCH_MS * 4);
    });
    expect(renders).toBe(afterSwitch);
  });
});
