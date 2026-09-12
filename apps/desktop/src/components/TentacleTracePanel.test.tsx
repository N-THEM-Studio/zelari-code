// @vitest-environment jsdom
/**
 * TentacleTracePanel (F2) contract under test:
 *   - clicking a tentacle row in the Sidebar opens the panel for THAT agent
 *     (the harness wires Sidebar + panel exactly as App does);
 *   - the panel shows the run's live radio trail, filtered to the tentacle
 *     when the spawn title matches, and SAYS SO when it does not (the radio
 *     file is per-run, so a silent whole-run dump would be dishonest);
 *   - without a radio session the panel falls back to the graph-scoped
 *     workbench markdown and labels it as run-scoped;
 *   - the close control hides it, and the empty state is explicit;
 *   - polling stays on WorkbenchLiveTail's 1500ms cadence (asserted on the
 *     setInterval argument: no real 1.5s wait, no new timer cadence).
 *
 * `./../agentClient` is mocked (Tauri `invoke` is unavailable under jsdom) and
 * `react` is pinned to the ROOT copy for the same reason as
 * LiveTasksPanel.test.tsx: apps/desktop ships its own node_modules React, and
 * two Reacts in one module graph break hooks.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TentacleTracePanel } from "./TentacleTracePanel";
import { Sidebar, type SidebarProps } from "./Sidebar";
import { listDir, readProjectTextIfChanged } from "../agentClient";
import type { ActivityAgent, RunActivityState } from "../activity";
import type { Conversation, DirEntry } from "../types";

vi.mock("react", async () => {
  // @ts-expect-error tsc: importing the runtime entry loses type info by design
  return await import("../../../../node_modules/react/index.js");
});

vi.mock("../agentClient", () => ({
  listDir: vi.fn(),
  readProjectTextIfChanged: vi.fn(),
}));

const CWD = "Z:\\w\\my-app";
const RADIO = ".zelari/radio";

const LEAD: ActivityAgent = { id: "lead", role: "lead", status: "running", tools: [] };
const T1: ActivityAgent = {
  id: "t1",
  parentId: "lead",
  role: "general",
  title: "tentacle-one",
  status: "running",
  phaseMessage: "phase: general",
  tools: [],
};
const T2: ActivityAgent = {
  id: "t2",
  parentId: "lead",
  role: "verify",
  title: "tentacle-two",
  status: "completed",
  tools: [],
};

function activity(runId: string): RunActivityState {
  return {
    runId,
    agentOrder: ["lead", "t1", "t2"],
    agents: { lead: LEAD, t1: T1, t2: T2 },
    warnings: [],
    controls: [],
  };
}

function mission(): Conversation {
  return {
    id: "m1",
    title: "mission-one",
    messages: [],
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    mode: "kraken",
    phase: "build",
    sessionId: "s-1",
    cwd: CWD,
  };
}

function sidebarProps(over: Partial<SidebarProps> = {}): SidebarProps {
  return {
    sessions: [mission()],
    filter: "active",
    activeId: "m1",
    isRunning: () => true,
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
    activity: activity("run-1"),
    activeRunId: "run-1",
    onSelectTentacle: () => {},
    ...over,
  };
}

function entry(name: string): DirEntry {
  return { name, path: `${RADIO}/${name}`, isDir: false };
}

/** What `list_dir` returns for the radio dir: the newest match wins. */
function stubRadioDir(entries: DirEntry[]): void {
  vi.mocked(listDir).mockResolvedValue({ path: RADIO, entries });
}

/** Fresh file content from `read_project_text` (signature never repeats). */
function stubFile(text: string): void {
  vi.mocked(readProjectTextIfChanged).mockImplementation(async (args, lastSig) => {
    const sig = `1:${text.length}`;
    if (lastSig === sig) return null;
    return {
      res: {
        path: args.path,
        absolute: `${CWD}\\${args.path.replace("/", "\\")}`,
        isDir: false,
        text,
        size: text.length,
        mtimeMs: 1,
      },
      sig,
    };
  });
}

/** Sidebar + panel wired the way App wires them (the F2 seam under test). */
function Host({
  sessionId = "s-1",
  cwd = CWD,
}: {
  sessionId?: string | null;
  cwd?: string | null;
}): ReactElement {
  const [agent, setAgent] = useState<ActivityAgent | null>(null);
  return (
    <>
      <Sidebar
        {...sidebarProps({ onSelectTentacle: setAgent, selectedTentacleId: agent?.id ?? null })}
      />
      <TentacleTracePanel
        agent={agent}
        cwd={cwd}
        sessionId={sessionId}
        onClose={() => setAgent(null)}
      />
    </>
  );
}

/** Click a tentacle row and flush the immediate poll tick. */
async function openTrace(agentId: string): Promise<void> {
  const row = document.querySelector<HTMLButtonElement>(
    `button.tentacle-row[data-agent-id="${agentId}"]`,
  );
  expect(row).toBeTruthy();
  await act(async () => {
    fireEvent.click(row!);
  });
}

const RADIO_LINES = [
  `{"ts":"2026-09-12T08:30:19.652Z","kind":"spawn","agent":"general","description":"tentacle-one"}`,
  `{"ts":"2026-09-12T08:30:20.000Z","kind":"progress","agent":"general","description":"tentacle-one","detail":"phase: general"}`,
  `{"ts":"2026-09-12T08:31:00.000Z","kind":"done","agent":"general","description":"tentacle-two","detail":"OTHER-TENTACLE-ROW"}`,
].join("\n");

beforeEach(() => {
  vi.mocked(listDir).mockReset();
  vi.mocked(readProjectTextIfChanged).mockReset();
  stubRadioDir([]);
  stubFile("");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TentacleTracePanel - open from the sidebar (F2)", () => {
  it("opening a row shows the live trace of THAT tentacle, filtered and labelled", async () => {
    stubRadioDir([entry("s-1.jsonl"), entry("workbench-kraken-x.md")]);
    stubFile(RADIO_LINES);

    render(<Host />);
    // Closed until a row is clicked.
    expect(screen.queryByLabelText("Trace live del tentacle")).toBeNull();

    await openTrace("t1");

    expect(screen.getByLabelText("Trace live del tentacle")).toBeTruthy();
    // The session radio file wins over the graph-scoped workbench markdown.
    expect(screen.getByText("s-1.jsonl")).toBeTruthy();
    expect(screen.getByText(/filtrata su questo tentacle/)).toBeTruthy();
    expect(screen.getByText("● live")).toBeTruthy();

    const rows = document.querySelectorAll(".tentacle-trace-event");
    expect(rows).toHaveLength(2); // spawn + progress of t1, not t2's done
    expect(rows[0].getAttribute("data-kind")).toBe("spawn");
    // Row content (the panel scope line echoes the same caption, so assert on
    // the row itself instead of on a screen-wide text query).
    expect(rows[1].textContent).toContain("phase: general");
    expect(within(screen.getByLabelText("Trace live del tentacle")).queryByText(/OTHER-TENTACLE-ROW/)).toBeNull();
  });

  it("close hides the panel", async () => {
    stubRadioDir([entry("s-1.jsonl")]);
    stubFile(RADIO_LINES);

    render(<Host />);
    await openTrace("t1");
    expect(screen.getByLabelText("Trace live del tentacle")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Chiudi il trace del tentacle"));
    });
    expect(screen.queryByLabelText("Trace live del tentacle")).toBeNull();
  });

  it("a finished tentacle opens too and shows its done row", async () => {
    stubRadioDir([entry("s-1.jsonl")]);
    stubFile(RADIO_LINES);

    render(<Host />);
    await openTrace("t2");

    expect(screen.getByText(/filtrata su questo tentacle/)).toBeTruthy();
    const rows = document.querySelectorAll(".tentacle-trace-event");
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute("data-kind")).toBe("done");
    expect(screen.getByText(/OTHER-TENTACLE-ROW/)).toBeTruthy();
  });

  it("no title match: says so and falls back to the whole-run tail", async () => {
    stubRadioDir([entry("s-1.jsonl")]);
    // A run whose events never carry this tentacle's title.
    stubFile(
      [
        `{"ts":"2026-09-12T08:30:19.652Z","kind":"spawn","agent":"explore","description":"altro task"}`,
      ].join("\n"),
    );

    render(<Host />);
    await openTrace("t1");

    expect(
      screen.getByText(/nessun evento con il titolo di questo tentacle — coda dell'intera run/),
    ).toBeTruthy();
    // Honest label, but content is still shown.
    expect(document.querySelectorAll(".tentacle-trace-event")).toHaveLength(1);
    expect(screen.getByText(/altro task/)).toBeTruthy();
  });

  it("tolerates a partially written last line (append without a lock)", async () => {
    stubRadioDir([entry("s-1.jsonl")]);
    stubFile(`${RADIO_LINES}\n{"ts":"2026-09-12T08:3`);

    render(<Host />);
    await openTrace("t1");

    expect(document.querySelectorAll(".tentacle-trace-event")).toHaveLength(2);
  });
});

describe("TentacleTracePanel - sources and honest empty state", () => {
  it("no radio session: falls back to the workbench markdown, labelled run-scoped", async () => {
    stubRadioDir([entry("workbench-kraken-mtjd4hl7.md")]);
    stubFile("# Kraken workbench\n\n## Wave\n\n| id | label |\n|----|-------|\n| e1 | explore |\n");

    render(<Host sessionId={null} />);
    await openTrace("t1");

    expect(screen.getByText(/file per grafo\/run, non per tentacle/)).toBeTruthy();
    expect(screen.getByText("workbench-kraken-mtjd4hl7.md")).toBeTruthy();
    expect(screen.getByText("Wave")).toBeTruthy(); // mini-markdown H2 subset
    expect(document.querySelectorAll(".tentacle-trace-event")).toHaveLength(0);
  });

  it("nothing in the radio dir: explicit empty state, not a blank panel", async () => {
    render(<Host />);
    await openTrace("t1");

    expect(screen.getByText(/Trace: nessun file in .zelari\/radio per questa missione/)).toBeTruthy();
    expect(screen.getByText(/Nessun file letto da/)).toBeTruthy();
  });

  it("a resolved but still empty radio file says it is empty", async () => {
    stubRadioDir([entry("s-1.jsonl")]);
    stubFile("");

    render(<Host />);
    await openTrace("t1");

    expect(screen.getByText(/s-1.jsonl è vuoto/)).toBeTruthy();
  });

  it("inert without a cwd (no project, no reads)", async () => {
    render(<Host cwd={null} />);
    await openTrace("t1");

    // Panel opens (the selection is a UI fact) but stays paused and empty.
    expect(screen.getByLabelText("Trace live del tentacle")).toBeTruthy();
    expect(screen.getByText("○ paused")).toBeTruthy();
    expect(screen.getByText(/Nessun file letto da/)).toBeTruthy();
  });
});

describe("TentacleTracePanel - polling cadence", () => {
  it("polls on WorkbenchLiveTail's existing 1500ms timer (no real wait)", async () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    stubRadioDir([entry("s-1.jsonl")]);
    stubFile(RADIO_LINES);

    render(<Host />);
    await openTrace("t1");

    expect(spy.mock.calls.some((call) => call[1] === 1500)).toBe(true);
    expect(screen.getByLabelText("Trace live del tentacle")).toBeTruthy();
  });
});
