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
 *     unseen marker comes from the run OR from the App-level `unseenByConv`;
 *   - F4 polish: every row also carries ITS run's project folder (basename of
 *     the run cwd, labeled fallback when unbound), the chat mode and the user
 *     prompt that started that run — two runs of the same prompt in different
 *     folders stay distinguishable.
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
import {
  formatClock,
  PROMPT_EXCERPT_MAX,
  PROMPT_FALLBACK,
  PROJECT_FALLBACK,
} from "./runDetails";
import type { ChatMessage, Conversation } from "../types";
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

/** A user prompt: the only role the row quotes. */
function msg(id: string, content: string, createdAt: number): ChatMessage {
  return { id, role: "user", content, createdAt };
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

  it("prints how long ago the run started next to its duration", () => {
    const { container } = render(
      <RunsDashboard
        {...props({
          state: state(
            run({
              runId: "r-live",
              conversationId: "c1",
              startedAt: T0 - 120_000,
            }),
            run({
              runId: "r-done",
              conversationId: "c2",
              status: "finished",
              startedAt: T0 - 3 * 3_600_000,
              finishedAt: T0 - 3 * 3_600_000 + 45_000,
            }),
          ),
          conversations: [conv({ id: "c1", title: "one" }), conv({ id: "c2", title: "two" })],
        })}
      />,
    );

    const liveRow = rowById(container, "r-live");
    expect(liveRow.querySelector(".runs-dash-ago")?.textContent).toBe("2 min fa");
    expect(liveRow.querySelector(".runs-dash-ago")?.getAttribute("title")).toBe(
      `Avviata alle ${formatClock(T0 - 120_000)}`,
    );
    expect(liveRow.querySelector(".runs-dash-time")?.textContent).toBe("2m");
    expect(rowById(container, "r-done").querySelector(".runs-dash-ago")?.textContent).toBe(
      "3 h fa",
    );
  });

  it("tells two runs of the SAME prompt apart by their project folder", () => {
    const prompt = msg("m1", "fix the failing test", T0 - 30_000);
    const { container } = render(
      <RunsDashboard
        {...props({
          state: state(
            run({ runId: "r-alpha", conversationId: "c-alpha", startedAt: T0 - 10_000 }),
            run({ runId: "r-beta", conversationId: "c-beta", startedAt: T0 - 20_000 }),
          ),
          conversations: [
            conv({
              id: "c-alpha",
              title: "alpha",
              cwd: "Z:\\work\\alpha-app",
              messages: [prompt],
            }),
            conv({
              id: "c-beta",
              title: "beta",
              cwd: "/home/me/beta-app",
              messages: [prompt],
            }),
          ],
        })}
      />,
    );

    const chipOf = (runId: string) =>
      rowById(container, runId).querySelector(".runs-dash-project");
    expect(chipOf("r-alpha")?.textContent).toBe("alpha-app");
    expect(chipOf("r-beta")?.textContent).toBe("beta-app");
    // The full cwd stays available as the chip tooltip, nothing is invented.
    expect(chipOf("r-alpha")?.getAttribute("title")).toBe("Z:\\work\\alpha-app");
    expect(chipOf("r-alpha")?.classList.contains("is-fallback")).toBe(false);
    // Identical prompt on both rows: the folder is what tells them apart.
    expect(
      rowsOf(container).map((r) => r.querySelector(".runs-dash-prompt")?.textContent),
    ).toEqual(["fix the failing test", "fix the failing test"]);
  });

  it("quotes the prompt that started the run and truncates a long one", () => {
    const long = `  first  line\nsecond line ${"x".repeat(200)}`;
    const { container } = render(
      <RunsDashboard
        {...props({
          state: state(
            run({ runId: "r-this", conversationId: "c1", startedAt: T0 - 5_000 }),
            run({
              runId: "r-long",
              conversationId: "c2",
              status: "finished",
              startedAt: T0 - 5_000,
              finishedAt: T0 - 1_000,
            }),
            run({
              runId: "r-none",
              conversationId: "c3",
              status: "finished",
              startedAt: T0 - 5_000,
              finishedAt: T0 - 2_000,
            }),
          ),
          conversations: [
            conv({
              id: "c1",
              title: "one",
              messages: [
                msg("m1", "the OLD prompt of the chat", T0 - 60_000),
                msg("m2", "the prompt of THIS run", T0 - 6_000),
                msg("m3", "sent AFTER the run started", T0 + 5_000),
              ],
            }),
            conv({ id: "c2", title: "two", messages: [msg("m4", long, T0 - 6_000)] }),
            conv({ id: "c3", title: "three" }),
          ],
        })}
      />,
    );

    // The prompt of THIS run, not the first one of the chat nor a later one.
    expect(rowById(container, "r-this").querySelector(".runs-dash-prompt")?.textContent).toBe(
      "the prompt of THIS run",
    );
    const excerpt = rowById(container, "r-long").querySelector(".runs-dash-prompt");
    expect(excerpt?.textContent?.startsWith("first line second line ")).toBe(true); // one line
    expect(excerpt?.textContent?.endsWith("…")).toBe(true);
    expect(excerpt?.textContent?.length).toBe(PROMPT_EXCERPT_MAX + 1); // JS cap…
    expect(excerpt?.getAttribute("class")).toContain("runs-dash-prompt"); // …CSS clips
    // No user message anywhere: the honest placeholder, never a fake prompt.
    expect(rowById(container, "r-none").querySelector(".runs-dash-prompt")?.textContent).toBe(
      PROMPT_FALLBACK,
    );
  });

  it("keeps a labeled fallback row when neither cwd nor prompt is known", () => {
    const { container } = render(
      <RunsDashboard
        {...props({
          state: state(run({ runId: "r1", conversationId: "gone" })),
          conversations: [],
        })}
      />,
    );

    const row = rowById(container, "r1");
    const chip = row.querySelector(".runs-dash-project");
    expect(chip?.textContent).toBe(PROJECT_FALLBACK);
    expect(chip?.classList.contains("is-fallback")).toBe(true);
    expect(chip?.getAttribute("title")).toBe("Nessuna cartella di lavoro impostata");
    expect(row.querySelector(".runs-dash-prompt")?.textContent).toBe(PROMPT_FALLBACK);
    expect(row.querySelector(".runs-dash-type")).toBeNull(); // no chat → no mode
    expect(row.querySelector(".runs-dash-title")?.textContent).toBe("gone");
    // The row is still actionable: the click-through contract is untouched.
    expect(row.tagName).toBe("BUTTON");
  });
});
