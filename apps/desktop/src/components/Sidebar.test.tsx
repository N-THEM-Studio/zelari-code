// @vitest-environment jsdom
/**
 * Sidebar (F1) contract under test:
 *   - the list is split in "Missioni" (`sessionId`) / "Chat" with the folder
 *     grouping and the collapse wiring preserved;
 *   - selection, archive/unarchive/delete and the Active/Archived tab all call
 *     back to App with the same arguments the inline sidebar used;
 *   - NO Kraken activity is rendered in the rail any more: the tentacle
 *     hierarchy that used to hang under the active entry is gone for good, and
 *     handing the rail run activity again must not bring it back;
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
    onRename: () => {},
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

  it("no longer hosts the runs-dashboard trigger (F4 moved it to the topbar)", () => {
    const { container } = render(<Sidebar {...props({ sessions: [mission, chat] })} />);
    expect(container.querySelector(".sidebar-dash-btn")).toBeNull();
    expect(screen.queryByLabelText("Apri la dashboard delle run")).toBeNull();
    // The rail keeps its own controls; "Runs" is nowhere in it any more.
    expect(container.querySelector(".sidebar-top")?.textContent).not.toContain("Runs");
    expect(screen.getByText("New chat")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
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

  /**
   * REOPEN-GUARD: Kraken activity is not the rail's business any more. The
   * props that used to drive the hierarchy no longer exist on `SidebarProps`,
   * so the run activity is handed over through a cast: even if it came back,
   * the rail must not grow tentacle rows again.
   */
  it("never paints tentacle rows, even when run activity is handed over", () => {
    const stale = {
      ...props({ sessions: [mission, chat] }),
      activity: activity("run-1"),
      activeRunId: "run-1",
      onSelectTentacle: () => {},
      selectedTentacleId: "t1",
    } as unknown as SidebarProps;
    const { container } = render(<Sidebar {...stale} />);

    expect(screen.queryByLabelText("Tentacles della missione attiva")).toBeNull();
    expect(container.querySelectorAll(".tentacle-row")).toHaveLength(0);
    expect(screen.queryByText("tentacle-one")).toBeNull();
    // The active-chat indicator is untouched by the removal.
    const active = container.querySelector(".session-item-wrap.active .session-title");
    expect(active?.textContent).toBe("mission-one");
  });
});

/**
 * F3 — the mission-level badge. Signal: the `verification_run` verdict App
 * resolves per conversation (`missionVerdictFor`). It is labelled `mission`,
 * and it is never a tentacle's: the rail paints no tentacle row any more.
 */
describe("Sidebar - mission verification badge (F3)", () => {
  const renderF3 = (missionVerdictFor?: SidebarProps["missionVerdictFor"]) =>
    render(
      <Sidebar
        {...props({
          sessions: [mission, chat],
          ...(missionVerdictFor ? { missionVerdictFor } : {}),
        })}
      />,
    );

  it("labels the mission verification as mission-level, never as a tentacle's", () => {
    const { container } = renderF3((id) =>
      id === "m1" ? { verdict: "BLOCKED", signal: "BLOCKED" } : undefined,
    );
    const missionBadges = [...container.querySelectorAll('.verdict-badge[data-scope="mission"]')];
    expect(missionBadges).toHaveLength(1); // m1 only: the chat has no verification_run
    expect(missionBadges[0].getAttribute("data-verdict")).toBe("BLOCKED");
    expect(missionBadges[0].textContent).toContain("mission"); // explicitly labelled
    // Nothing tentacle-scoped can be painted by the rail any more.
    expect(container.querySelector('.verdict-badge[data-scope="tentacle"]')).toBeNull();
  });

  it("invents no badge when the backend sent no verification_run", () => {
    const { container } = renderF3();
    expect(container.querySelector('.verdict-badge[data-scope="mission"]')).toBeNull();
  });
});

/**
 * grok-round — inline rename. Contract: the row becomes a prefilled input;
 * Enter and blur commit the TRIMMED title exactly once (Enter is followed by a
 * blur in a real window), Esc reverts, and an empty/whitespace-only title is
 * refused so a nameless row can never reach App's store. The sidebar owns no
 * storage here: it only reports `(id, title)` — App maps by id.
 */
describe("Sidebar - inline rename (grok-round)", () => {
  const renameField = () =>
    screen.getByLabelText("Conversation title") as HTMLInputElement;

  function renderRename(onRename: (id: string, title: string) => void) {
    return render(<Sidebar {...props({ sessions: [mission], onRename })} />);
  }

  it("opens a prefilled input from the hover action and commits on Enter", () => {
    const calls: Array<[string, string]> = [];
    renderRename((id, title) => calls.push([id, title]));

    fireEvent.click(screen.getByTitle("Rename"));
    const field = renameField();
    // Prefilled with the stored title, and the row is showing the editor, not
    // the button — a click can no longer re-select the conversation.
    expect(field.value).toBe("mission-one");
    expect(screen.queryByTitle("Rename")).toBeNull();

    fireEvent.change(field, { target: { value: "  renamed  " } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(calls).toEqual([["m1", "renamed"]]); // trimmed, once
    expect(screen.queryByLabelText("Conversation title")).toBeNull();
    expect(screen.getByText("mission-one")).toBeTruthy(); // App still owns the title
  });

  it("commits on blur, not on the Enter that precedes it", () => {
    const calls: Array<[string, string]> = [];
    renderRename((id, title) => calls.push([id, title]));

    fireEvent.click(screen.getByTitle("Rename"));
    const field = renameField();
    fireEvent.change(field, { target: { value: "from-blur" } });
    // Enter commits and closes the editor; the blur a real browser then fires
    // on the removed node must not report a second time.
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.blur(field);

    expect(calls).toEqual([["m1", "from-blur"]]);
  });

  it("reverts on Escape and reports nothing", () => {
    const calls: Array<[string, string]> = [];
    renderRename((id, title) => calls.push([id, title]));

    fireEvent.click(screen.getByTitle("Rename"));
    const field = renameField();
    fireEvent.change(field, { target: { value: "discarded" } });
    fireEvent.keyDown(field, { key: "Escape" });

    expect(calls).toEqual([]);
    expect(screen.queryByLabelText("Conversation title")).toBeNull();
    expect(screen.getByText("mission-one")).toBeTruthy(); // the old title stands
  });

  it("refuses an empty or whitespace-only title and keeps the old one", () => {
    const calls: Array<[string, string]> = [];
    renderRename((id, title) => calls.push([id, title]));

    fireEvent.click(screen.getByTitle("Rename"));
    fireEvent.change(renameField(), { target: { value: "   " } });
    fireEvent.keyDown(renameField(), { key: "Enter" });

    expect(calls).toEqual([]);
    expect(screen.queryByLabelText("Conversation title")).toBeNull();
    expect(screen.getByText("mission-one")).toBeTruthy();
  });

  it("does not report an unchanged title (reopening rename is not an edit)", () => {
    const calls: Array<[string, string]> = [];
    renderRename((id, title) => calls.push([id, title]));

    fireEvent.click(screen.getByTitle("Rename"));
    const field = renameField();
    fireEvent.change(field, { target: { value: " mission-one " } }); // same after trim
    fireEvent.keyDown(field, { key: "Enter" });

    expect(calls).toEqual([]);
    expect(screen.queryByLabelText("Conversation title")).toBeNull();
  });
});
