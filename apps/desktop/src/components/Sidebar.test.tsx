// @vitest-environment jsdom
/**
 * Sidebar (F1) contract under test:
 *   - the list is split in "Missioni" (`sessionId`) / "Chat" with the folder
 *     grouping and the collapse wiring preserved;
 *   - selection, archive/unarchive/delete and the Active/Archived tab all call
 *     back to App with the same arguments the inline sidebar used;
 *   - the tentacle hierarchy under the active entry comes from the run activity
 *     (`parentId` children) and is painted ONLY for the run that entry owns -
 *     an unrelated/stale run id must not leak into it.
 *
 * vi.mock('react'): apps/desktop has its own node_modules copy of React
 * (npm --prefix install), while @testing-library/react at the root uses the
 * root copy - two Reacts in one module graph break hooks. Same pin as
 * LiveTasksPanel.test.tsx.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar, type SidebarProps } from "./Sidebar";
import { NO_FOLDER_KEY } from "../sessionGroups";
import type { ActivityAgent, RunActivityState } from "../activity";
import type { Conversation } from "../types";

vi.mock("react", async () => {
  // @ts-expect-error tsc: importing the runtime entry loses type info by design
  return await import("../../../../node_modules/react/index.js");
});

// Same family as TentacleTracePanel.test.tsx: the Sidebar import chain pulls
// `../activity` (barrel) → `useRunActivity` → `../agentClient` → Tauri APIs,
// which do not resolve under the root-only CI install (`npm ci` does not
// populate apps/desktop/node_modules). Mock the first-party seam; the hook
// itself is never invoked in these tests.
vi.mock("../agentClient", () => ({
  onAgentEvent: vi.fn(async () => () => {}),
}));

afterEach(cleanup);

const HOUR = 1700000000000;

function conv(over: Partial<Conversation> & { id: string }): Conversation {
  return {
    title: `chat-${over.id}`,
    messages: [],
    createdAt: HOUR,
    updatedAt: HOUR,
    mode: "kraken",
    phase: "build",
    ...over,
  };
}

function activity(runId: string): RunActivityState {
  const lead: ActivityAgent = { id: "lead", role: "lead", status: "running", tools: [] };
  const one: ActivityAgent = {
    id: "t1",
    parentId: "lead",
    role: "general",
    title: "tentacle-one",
    status: "running",
    phaseMessage: "phase: general",
    tools: [],
  };
  const two: ActivityAgent = {
    id: "t2",
    parentId: "lead",
    role: "verify",
    title: "tentacle-two",
    status: "completed",
    durationMs: 1500,
    tools: [],
  };
  return {
    runId,
    agentOrder: ["lead", "t1", "t2"],
    agents: { lead, t1: one, t2: two },
    warnings: [],
    controls: [],
  };
}

function props(over: Partial<SidebarProps> = {}): SidebarProps {
  return {
    sessions: [],
    filter: "active",
    activeId: "m1",
    isRunning: () => false,
    unseenByConv: {},
    collapsedFolders: new Set<string>(),
    onToggleFolder: () => {},
    onNewChat: () => {},
    newChatDisabled: false,
    onSelect: () => {},
    onArchive: () => {},
    onUnarchive: () => {},
    onDelete: () => {},
    onFilterChange: () => {},
    onOpenSettings: () => {},
    cliOk: true,
    statusLine: "ready",
    resizer: {
      onPointerDown: () => {},
      onPointerMove: () => {},
      onPointerUp: () => {},
      onDoubleClick: () => {},
    },
    activity: { agentOrder: [], agents: {}, warnings: [], controls: [] },
    onSelectTentacle: () => {},
    ...over,
  };
}

const mission = conv({ id: "m1", title: "mission-one", sessionId: "s-1", cwd: "Z:\\w\\my-app" });
const chat = conv({ id: "c1", title: "plain-one" });

describe("Sidebar - Missioni / Chat sections", () => {
  it("splits by sessionId and keeps the folder grouping", () => {
    render(<Sidebar {...props({ sessions: [mission, chat] })} />);
    expect(screen.getByText("Missioni")).toBeTruthy();
    expect(screen.getByText("Chat")).toBeTruthy();
    expect(screen.getByText("mission-one")).toBeTruthy();
    expect(screen.getByText("plain-one")).toBeTruthy();
    expect(screen.getByText("📁 my-app")).toBeTruthy();
    expect(screen.getByText("📁 No folder")).toBeTruthy();
  });

  it("marks the active entry and hides collapsed folders", () => {
    const { container } = render(
      <Sidebar
        {...props({
          sessions: [mission, chat],
          collapsedFolders: new Set([NO_FOLDER_KEY]),
        })}
      />,
    );
    const active = container.querySelector(".session-item-wrap.active");
    expect(active?.querySelector(".session-title")?.textContent).toBe("mission-one");
    // The cwd-less chat sits in the collapsed "No folder" group.
    expect(screen.queryByText("plain-one")).toBeNull();
  });

  it("wires new chat, tab switch, selection, archive and delete", () => {
    const calls: string[] = [];
    render(
      <Sidebar
        {...props({
          sessions: [mission],
          onNewChat: () => calls.push("new"),
          onFilterChange: (f) => calls.push(`filter:${f}`),
          onSelect: (c) => calls.push(`select:${c.id}`),
          onArchive: (id) => calls.push(`archive:${id}`),
          onDelete: (id) => calls.push(`delete:${id}`),
        })}
      />,
    );
    fireEvent.click(screen.getByText("New chat"));
    fireEvent.click(screen.getByText("Archived"));
    fireEvent.click(screen.getByText("mission-one"));
    fireEvent.click(screen.getByTitle("Archive"));
    fireEvent.click(screen.getByTitle("Delete"));
    expect(calls).toEqual([
      "new",
      "filter:archived",
      "select:m1",
      "archive:m1",
      "delete:m1",
    ]);
  });

  it("renders the active entry's tentacles from the run activity", () => {
    render(
      <Sidebar
        {...props({ sessions: [mission], activity: activity("run-1"), activeRunId: "run-1" })}
      />,
    );
    expect(screen.getByLabelText("Tentacles della missione attiva")).toBeTruthy();
    expect(screen.getByText("tentacle-one")).toBeTruthy();
    expect(screen.getByText("tentacle-two")).toBeTruthy();
    expect(screen.getByText("phase: general")).toBeTruthy();
  });

  it("never paints another run's tentacles under the active entry", () => {
    const { container } = render(
      <Sidebar
        {...props({
          sessions: [mission, conv({ id: "m2", title: "mission-two", sessionId: "s-2" })],
          activity: activity("run-2"),
          activeRunId: "run-1",
        })}
      />,
    );
    expect(container.querySelector('[aria-label="Tentacles della missione attiva"]')).toBeNull();
    expect(screen.queryByText("tentacle-one")).toBeNull();
  });

  it("shows no hierarchy when no agent was spawned", () => {
    const { container } = render(
      <Sidebar {...props({ sessions: [mission], activeRunId: "run-1" })} />,
    );
    expect(container.querySelectorAll(".session-item-wrap")).toHaveLength(1);
    expect(
      container.querySelector('[aria-label="Tentacles della missione attiva"]'),
    ).toBeNull();
  });

  it("reports the clicked tentacle (F2) and marks the traced row", () => {
    const picked: string[] = [];
    const { container } = render(
      <Sidebar
        {...props({
          sessions: [mission],
          activity: activity("run-1"),
          activeRunId: "run-1",
          onSelectTentacle: (a) => picked.push(a.id),
          selectedTentacleId: "t2",
        })}
      />,
    );
    const row1 = container.querySelector<HTMLButtonElement>('button.tentacle-row[data-agent-id="t1"]');
    const row2 = container.querySelector<HTMLButtonElement>('button.tentacle-row[data-agent-id="t2"]');
    // Keyboard reachable button, not a clickable div.
    expect(row1?.tagName).toBe("BUTTON");
    expect(row1?.getAttribute("aria-pressed")).toBe("false");
    expect(row2?.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(row1!);
    fireEvent.keyDown(row1!, { key: "Enter" });
    // A `<button>` fires click on Enter natively; the keydown alone must not
    // double-report, and every click reports exactly one agent.
    expect(picked).toEqual(["t1"]);
  });

  it("without a selection no row is marked pressed", () => {
    const { container } = render(
      <Sidebar {...props({ sessions: [mission], activity: activity("run-1"), activeRunId: "run-1" })} />,
    );
    const rows = [...container.querySelectorAll("button.tentacle-row")];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.getAttribute("aria-pressed"))).toEqual(["false", "false"]);
  });
});

/**
 * F3 — badges. Signal: the real `ActivityAgent.phaseMessage` caption
 * (`agent_status.message`: `taskTool.ts` `emitVerifyPhase` → `reducer.ts`).
 * Unknown captions degrade to "—"; a mission verdict is never a row's verdict.
 */
describe("Sidebar - per-tentacle verification badges (F3)", () => {
  /** One row per caption shape `emitVerifyPhase` can send. */
  function verdictActivity(runId: string): RunActivityState {
    const rows: Array<[string, string | undefined]> = [
      ["g-pass", "verify PASS"],
      ["g-fail", "verify FAIL"],
      ["g-blocked", "verify BLOCKED"],
      ["g-unknown", "verify unknown"],
      ["g-nosilence", undefined],
    ];
    const lead: ActivityAgent = { id: "lead", role: "lead", status: "running", tools: [] };
    const agents: Record<string, ActivityAgent> = { lead };
    for (const [id, phaseMessage] of rows) {
      agents[id] = { id, parentId: "lead", role: "general", title: id, status: "completed", ...(phaseMessage ? { phaseMessage } : {}), tools: [] };
    }
    return { runId, agentOrder: ["lead", ...rows.map(([id]) => id)], agents, warnings: [], controls: [] };
  }
  const badgeFor = (c: HTMLElement, id: string) => c.querySelector(`button.tentacle-row[data-agent-id="${id}"] .verdict-badge`);
  const renderF3 = (missionVerdictFor?: SidebarProps["missionVerdictFor"]) =>
    render(<Sidebar {...props({ sessions: [mission, chat], activity: verdictActivity("run-1"), activeRunId: "run-1", ...(missionVerdictFor ? { missionVerdictFor } : {}) })} />);

  it("paints each row from its own caption and degrades to — when there is none", () => {
    const { container } = renderF3();
    expect(badgeFor(container, "g-pass")?.getAttribute("data-verdict")).toBe("PASS");
    expect(badgeFor(container, "g-pass")?.getAttribute("data-scope")).toBe("tentacle");
    expect(badgeFor(container, "g-pass")?.textContent).toBe("✓ PASS");
    expect(badgeFor(container, "g-fail")?.getAttribute("data-verdict")).toBe("REPAIR_REQUIRED");
    expect(badgeFor(container, "g-blocked")?.getAttribute("data-verdict")).toBe("BLOCKED");
    // "verify unknown" IS a signal but carries no verdict, and a row with no
    // caption never becomes PASS (ADR-0023: unknown ≠ pass).
    for (const id of ["g-unknown", "g-nosilence"]) {
      expect(badgeFor(container, id)?.getAttribute("data-verdict")).toBe("unknown");
      expect(badgeFor(container, id)?.textContent).toBe("—");
    }
    expect(screen.getAllByText("✓ PASS")).toHaveLength(1); // only the PASS caption
    // And with no verification_run for anyone, no mission badge is invented.
    expect(container.querySelector('.verdict-badge[data-scope="mission"]')).toBeNull();
  });

  it("labels the mission verification as mission-level, never as a tentacle's", () => {
    const { container } = renderF3((id) => (id === "m1" ? { verdict: "BLOCKED", signal: "BLOCKED" } : undefined));
    const missionBadges = [...container.querySelectorAll('.verdict-badge[data-scope="mission"]')];
    expect(missionBadges).toHaveLength(1); // m1 only: the chat has no verification_run
    expect(missionBadges[0].getAttribute("data-verdict")).toBe("BLOCKED");
    expect(missionBadges[0].textContent).toContain("mission"); // explicitly labelled
    // Rows keep their OWN signal: no caption stays "—", a PASS caption is not
    // overwritten by the mission's BLOCKED, and only its own caption says BLOCKED.
    expect(badgeFor(container, "g-nosilence")?.getAttribute("data-verdict")).toBe("unknown");
    expect(badgeFor(container, "g-pass")?.getAttribute("data-verdict")).toBe("PASS");
    const blockedRows = container.querySelectorAll('button.tentacle-row .verdict-badge[data-verdict="BLOCKED"]');
    expect(blockedRows).toHaveLength(1); // g-blocked's caption, not an inheritance
    expect(badgeFor(container, "g-nosilence")?.textContent).toBe("—");
  });
});
