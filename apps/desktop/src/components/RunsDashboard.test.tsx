// @vitest-environment jsdom
/**
 * RunsDashboard (F4) contract under test:
 *   - closed → renders nothing at all;
 *   - every run of the registry gets a row: active (starting/running) first,
 *     then the retained ones by end time desc, each titled by joining
 *     `conversationId` against the conversation list (id as honest fallback);
 *   - a row click reports the CONVERSATION id to App (the dashboard selects
 *     nothing itself) and closes the drawer;
 *   - an empty registry says so instead of showing a bare list;
 *   - the time column is elapsed (active) vs duration (finished) and the
 *     unseen marker comes from the run OR from the App-level `unseenByConv`.
 *
 * vi.mock('react'): apps/desktop has its own node_modules copy of React
 * (npm --prefix install), while @testing-library/react at the root uses the
 * root copy - two Reacts in one module graph break hooks. Same pin as
 * Sidebar.test.tsx.
 *
 * No `agentClient` mock here on purpose: the component is pure presentational
 * and must stay free of `activity`/`agentClient` imports.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunsDashboard, type RunsDashboardProps } from "./RunsDashboard";
import type { Conversation } from "../types";
import type { RunRegistryState, RunRuntime } from "../runs/types";

vi.mock("react", async () => {
  // @ts-expect-error tsc: importing the runtime entry loses type info by design
  return await import("../../../../node_modules/react/index.js");
});

afterEach(cleanup);

const T0 = 1_700_000_000_000;

function conv(over: Partial<Conversation> & { id: string }): Conversation {
  return {
    title: `chat-${over.id}`,
    messages: [],
    createdAt: T0,
    updatedAt: T0,
    mode: "kraken",
    phase: "build",
    ...over,
  };
}

function run(
  over: Partial<RunRuntime> & { runId: string; conversationId: string },
): RunRuntime {
  return { status: "running", startedAt: T0, ...over };
}

function state(...runs: RunRuntime[]): RunRegistryState {
  const runsById: Record<string, RunRuntime> = {};
  for (const r of runs) runsById[r.runId] = r;
  return { runsById, runIdByConversation: {} };
}

function props(over: Partial<RunsDashboardProps> = {}): RunsDashboardProps {
  return {
    open: true,
    state: state(),
    conversations: [],
    unseenByConv: {},
    onSelectSession: () => {},
    onClose: () => {},
    now: T0, // frozen clock: the time column stays deterministic
    ...over,
  };
}

const rowsOf = (container: HTMLElement): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>("button.runs-dash-row"),
];

const rowById = (container: HTMLElement, runId: string): HTMLButtonElement =>
  rowsOf(container).find((r) => r.getAttribute("data-run-id") === runId)!;

const pillsOf = (row: HTMLElement): string[] =>
  [...row.querySelectorAll(".runs-dash-pill")].map((p) =>
    [...p.classList].filter((c) => c.startsWith("status-")).join("|"),
  );

describe("RunsDashboard", () => {
  it("renders nothing while closed", () => {
    const { container } = render(
      <RunsDashboard
        {...props({
          open: false,
          state: state(run({ runId: "r1", conversationId: "c1" })),
        })}
      />,
    );
    expect(container.querySelector(".runs-dash")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("lists the active run first, joins titles and counts the live runs", () => {
    const { container } = render(
      <RunsDashboard
        {...props({
          state: state(
            run({
              runId: "r-old",
              conversationId: "c2",
              status: "finished",
              startedAt: T0 - 60_000,
              finishedAt: T0 - 45_000,
            }),
            run({
              runId: "r-live",
              conversationId: "c1",
              status: "running",
              startedAt: T0 - 120_000,
            }),
            run({
              runId: "r-new",
              conversationId: "c3",
              status: "finished",
              startedAt: T0 - 10_000,
              finishedAt: T0 - 5_000,
            }),
          ),
          conversations: [
            conv({ id: "c1", title: "mission-one" }),
            conv({ id: "c2", title: "chat-two" }),
            conv({ id: "c3", title: "chat-three" }),
          ],
        })}
      />,
    );

    // Active first (newest start first), then the retained ones by end time.
    expect(rowsOf(container).map((r) => r.getAttribute("data-run-id"))).toEqual([
      "r-live",
      "r-new",
      "r-old",
    ]);
    // Title joined from the conversation of the run, never the run id.
    expect(rowById(container, "r-live").querySelector(".runs-dash-title")?.textContent).toBe(
      "mission-one",
    );
    expect(pillsOf(rowById(container, "r-live"))).toEqual(["status-running"]);
    expect(rowById(container, "r-live").querySelector(".runs-dash-pill")?.textContent).toBe(
      "running",
    );
    // The pulsing dot is a live-only affordance.
    expect(rowById(container, "r-live").querySelector(".runs-dash-dot")).toBeTruthy();
    expect(rowById(container, "r-new").querySelector(".runs-dash-dot")).toBeNull();
    expect(pillsOf(rowById(container, "r-new"))).toEqual(["status-finished"]);
    // Header badge = activeRunCount(state).
    expect(container.querySelector(".runs-dash-count")?.textContent).toBe("1");
  });

  it("paints one pill per status and falls back to the id when the chat is gone", () => {
    const { container } = render(
      <RunsDashboard
        {...props({
          state: state(
            run({ runId: "r1", conversationId: "deleted", status: "starting" }),
            run({ runId: "r2", conversationId: "deleted", status: "error", finishedAt: T0 }),
            run({
              runId: "r3",
              conversationId: "deleted",
              status: "cancelled",
              finishedAt: T0,
            }),
          ),
          conversations: [conv({ id: "other", title: "not-this-one" })],
        })}
      />,
    );
    expect(rowsOf(container).map((r) => r.getAttribute("data-status"))).toEqual([
      "starting",
      "error",
      "cancelled",
    ]);
    expect(rowsOf(container).map(pillsOf)).toEqual([
      ["status-starting"],
      ["status-error"],
      ["status-cancelled"],
    ]);
    // No conversation to join: the raw id is shown instead of an empty label.
    expect(
      rowsOf(container).every(
        (r) => r.querySelector(".runs-dash-title")?.textContent === "deleted",
      ),
    ).toBe(true);
  });

  it("reports the clicked conversation and closes the drawer", () => {
    const picked: string[] = [];
    let closed = 0;
    const { container } = render(
      <RunsDashboard
        {...props({
          state: state(
            run({ runId: "r1", conversationId: "c1" }),
            run({
              runId: "r2",
              conversationId: "c2",
              status: "finished",
              startedAt: T0 - 5_000,
              finishedAt: T0 - 1_000,
            }),
          ),
          conversations: [conv({ id: "c1", title: "one" }), conv({ id: "c2", title: "two" })],
          onSelectSession: (id) => picked.push(id),
          onClose: () => {
            closed += 1;
          },
        })}
      />,
    );

    const rows = rowsOf(container);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.tagName === "BUTTON")).toBe(true); // keyboard reachable
    fireEvent.click(rows[1]); // the finished one -> its own conversation
    expect(picked).toEqual(["c2"]);
    expect(closed).toBe(1);

    fireEvent.click(container.querySelector<HTMLButtonElement>(".workbench-panel-close")!);
    expect(closed).toBe(2);
    expect(picked).toEqual(["c2"]); // closing never selects anything
  });

  it("says there is no run yet instead of showing an empty list", () => {
    const { container } = render(<RunsDashboard {...props()} />);
    expect(container.querySelector(".runs-dash-empty")?.textContent).toBe("Nessun run ancora");
    expect(rowsOf(container)).toHaveLength(0);
    expect(container.querySelector(".runs-dash-count")?.textContent).toBe("0");
    expect(container.textContent).toContain("0 run in registro");
  });

  it("prints elapsed for active runs, duration for finished ones, and unseen marks", () => {
    const { container } = render(
      <RunsDashboard
        {...props({
          state: state(
            run({
              runId: "r-live",
              conversationId: "c1",
              status: "running",
              startedAt: T0 - 120_000,
            }),
            run({
              runId: "r-done",
              conversationId: "c2",
              status: "finished",
              startedAt: T0 - 100_000,
              finishedAt: T0 - 55_000,
              unseenResult: true,
            }),
            run({
              runId: "r-seen",
              conversationId: "c3",
              status: "finished",
              startedAt: T0 - 5_000,
              finishedAt: T0 - 2_000,
            }),
          ),
          conversations: [
            conv({ id: "c1", title: "one" }),
            conv({ id: "c2", title: "two" }),
            conv({ id: "c3", title: "three" }),
          ],
          unseenByConv: { c3: true }, // App-level badge, no flag on the run
        })}
      />,
    );

    expect(rowById(container, "r-live").querySelector(".runs-dash-time")?.textContent).toBe("2m");
    expect(rowById(container, "r-done").querySelector(".runs-dash-time")?.textContent).toBe("45s");
    expect(rowById(container, "r-done").querySelector(".runs-dash-unseen")).toBeTruthy();
    expect(rowById(container, "r-seen").querySelector(".runs-dash-unseen")).toBeTruthy();
    expect(rowById(container, "r-live").querySelector(".runs-dash-unseen")).toBeNull();
  });
});
