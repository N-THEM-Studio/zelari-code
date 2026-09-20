// @vitest-environment jsdom
/**
 * KrakenActivity presentation contract (readability pass).
 *
 * The panel used to be a wall of inline styles with a shouted header
 * ("KRAKEN ACTIVITY") and dense unaligned rows. It is now class-driven
 * (`.kraken-act-*`): calm header, a thin done/total bar, compact rows.
 *
 * What must NOT regress while that happens:
 *   - `aria-label="Kraken Activity"` still names the section;
 *   - agent titles, the `kraken-thinking-chip` (text `effort: <x>`) and the
 *     warning lines stay visible in the DEFAULT render (no expanding);
 *   - zero inline `style` attributes are left in the panel.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async () => {
  // @ts-expect-error tsc: importing the runtime entry loses type info by design
  return await import("../../../../node_modules/react/index.js");
});

vi.mock("../agentClient", () => ({
  onAgentEvent: vi.fn(async () => () => {}),
}));

import { onAgentEvent } from "../agentClient";
import { flushSidecarBatches } from "../hooks/useSidecarBatch";
import { clearActivityStoreForTests } from "../activity/useRunActivity";
import { KrakenActivity } from "./KrakenActivity";

type Handler = (event: unknown) => void;

let handlers: Handler[] = [];

function armMock(): void {
  vi.mocked(onAgentEvent).mockImplementation(async (h) => {
    handlers.push(h as unknown as Handler);
    return () => {
      const i = handlers.indexOf(h as unknown as Handler);
      if (i >= 0) handlers.splice(i, 1);
    };
  });
}

/**
 * Dispatch one event, then land the coalesced activity paint — the same
 * boundary flush App performs at message_end / run-finished (SLICE7). The
 * panel's tree is batched, so without the flush the assertions would read a
 * mid-window frame instead of the settled one.
 */
function emit(ev: unknown): void {
  act(() => {
    for (const h of handlers) h(ev);
    flushSidecarBatches();
  });
}

const LEAD = {
  type: "agent_spawned",
  conversationId: "conv-K",
  runId: "run-K",
  agentId: "k-lead",
  role: "lead",
  title: "Ship the readability pass",
  ts: 1,
};

const TENTACLE = {
  ...LEAD,
  agentId: "k-t1",
  role: "explore",
  title: "Map the composer",
  model: "grok-4",
  thinking: "high",
  ts: 2,
};

afterEach(cleanup);

describe("KrakenActivity — presentation", () => {
  beforeEach(() => {
    handlers = [];
    vi.mocked(onAgentEvent).mockReset();
    clearActivityStoreForTests();
  });

  it("has a calm header, a thin done/total bar and compact counters", () => {
    armMock();
    render(<KrakenActivity conversationId="conv-K" />);
    emit(LEAD);
    emit(TENTACLE);
    emit({
      type: "agent_status",
      conversationId: "conv-K",
      runId: "run-K",
      agentId: "k-t1",
      status: "running",
      ts: 3,
    });

    expect(screen.getByLabelText("Kraken Activity")).toBeTruthy();
    expect(screen.getByText("Kraken activity")).toBeTruthy();
    expect(screen.queryByText("KRAKEN ACTIVITY")).toBeNull();

    const bar = document.querySelector("progress.kraken-act-bar");
    expect(bar).toBeTruthy();
    expect(bar!.getAttribute("value")).toBe("0");
    expect(bar!.getAttribute("max")).toBe("2");

    expect(screen.getByText(/^0\/2 done/)).toBeTruthy();
    // The lead counts as running too — counters stay honest, just compact.
    expect(screen.getByText(/^0\/2 done · 2 running$/)).toBeTruthy();
  });

  it("keeps titles, the effort chip and warnings visible without expanding", () => {
    armMock();
    render(<KrakenActivity conversationId="conv-K" />);
    emit(LEAD);
    emit(TENTACLE);
    emit({
      type: "agent_status",
      conversationId: "conv-K",
      runId: "run-K",
      agentId: "k-t1",
      status: "failed",
      message: "boom in the panel",
      ts: 4,
    });

    // Visible in the DEFAULT render: the rows are rendered expanded for a
    // small run, and the warning lines are never behind a second toggle.
    expect(screen.getByText("Ship the readability pass")).toBeTruthy();
    expect(screen.getByText("Map the composer")).toBeTruthy();
    expect(screen.getByText("effort: high")).toBeTruthy();
    expect(document.querySelector(".kraken-thinking-chip")).toBeTruthy();
    // The failed message shows twice by reducer design: as the tentacle's
    // phase caption AND as a warning line. Both are visible by default.
    expect(screen.getAllByText(/boom in the panel/).length).toBe(2);
    const warn = document.querySelector(".kraken-act-warn");
    expect(warn!.textContent).toBe("⚠ k-t1: boom in the panel");
    expect(document.querySelectorAll(".kraken-act-warn").length).toBe(1);

    // Counters now report the failure too, and the bar moved.
    expect(screen.getByText(/^1\/2 done/)).toBeTruthy();
    expect(screen.getByText(/1 failed/)).toBeTruthy();
    expect(document.querySelector("progress.kraken-act-bar")!.getAttribute("value")).toBe("1");
  });

  it("folds every inline style into classes", () => {
    armMock();
    render(<KrakenActivity conversationId="conv-K" />);
    emit(LEAD);
    emit(TENTACLE);
    emit({
      type: "agent_status",
      conversationId: "conv-K",
      runId: "run-K",
      agentId: "k-t1",
      status: "running",
      tool: "edit",
      ts: 5,
    });

    expect(document.querySelectorAll(".kraken-act [style]").length).toBe(0);
    // Lead and tentacles share the SAME row component (§19): aligned,
    // clickable, expandable — the lead just carries the is-lead modifier.
    expect(document.querySelectorAll(".kraken-act-row").length).toBe(2);
    expect(document.querySelectorAll(".kraken-act-row.is-lead").length).toBe(1);
    expect(document.querySelectorAll(".kraken-act-lead").length).toBe(0);
    expect(document.querySelector(".kraken-act-body")).toBeTruthy();
  });

  it("stays inert until an agent is attributed to this conversation", () => {
    armMock();
    render(<KrakenActivity conversationId="conv-K" />);
    expect(document.querySelector(".kraken-act")).toBeNull();
    emit({ ...LEAD, conversationId: "conv-other" });
    expect(document.querySelector(".kraken-act")).toBeNull();
  });

  it("expands the lead row on click like any tentacle (§19)", () => {
    armMock();
    render(<KrakenActivity conversationId="conv-K" />);
    emit(LEAD);
    emit(TENTACLE);

    const leadRow = screen.getByText("Ship the readability pass").closest(".kraken-act-row");
    expect(leadRow).toBeTruthy();
    expect(leadRow!.classList.contains("is-lead")).toBe(true);
    expect(leadRow!.querySelector(".kraken-act-details")).toBeNull();

    fireEvent.click(leadRow!);
    expect(leadRow!.querySelector(".kraken-act-details")).toBeTruthy();
  });
});
