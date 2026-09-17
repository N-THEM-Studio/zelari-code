// @vitest-environment jsdom
/**
 * RunsHistoryCard — Settings → Automations: run history + evidence for one
 * automation. P1: a post is ok ONLY with ok:true AND a url; exit 4
 * (unproven / relogin_required) is a STATE chip, never a red error.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAutomationRuns, type AutomationRunJson } from "../../agentClient";
import { RunsHistoryCard, exitBadge, runStatusChip } from "./RunsHistoryCard";

vi.mock("react", async () => {
  // @ts-expect-error tsc: importing the runtime entry loses type info by design
  return await import("../../../../../node_modules/react/index.js");
});

vi.mock("../../agentClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agentClient")>();
  return { ...actual, listAutomationRuns: vi.fn() };
});

const runsMock = vi.mocked(listAutomationRuns);

function renderCard(automationId: string | null = "soc", workdir: string | null = "Z:/repo") {
  return render(<RunsHistoryCard workdir={workdir} automationId={automationId} />);
}

beforeEach(() => {
  runsMock.mockReset();
  runsMock.mockResolvedValue({ id: "soc", runs: [] });
});

afterEach(cleanup);

const COMPLETED: AutomationRunJson = {
  runId: "20260101000000-aaaa",
  automationId: "soc",
  status: "completed",
  exitCode: 0,
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:01:00.000Z",
  draft: {
    text: "Hello world",
    generatedBy: { source: "llm", provider: "anthropic", model: "claude-sonnet-4" },
  },
  approvals: [{ at: "2026-01-01T00:00:30.000Z", decision: "allow" }],
  posts: [
    {
      channel: "x",
      ok: true,
      url: "https://x.com/i/1",
      postId: "1",
      screenshot: "runs/soc/x.png",
    },
  ],
};

describe("RunsHistoryCard", () => {
  it("renders a completed run with a clickable permalink + screenshot evidence", async () => {
    runsMock.mockResolvedValue({ id: "soc", runs: [COMPLETED] });
    renderCard();

    expect(await screen.findByText("Hello world")).toBeTruthy();
    expect(screen.getByText("completato")).toBeTruthy();

    const link = screen.getByRole("link", { name: "https://x.com/i/1" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://x.com/i/1");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(screen.getByText("screenshot: runs/soc/x.png")).toBeTruthy();
    expect(screen.getByText(/generato da llm · anthropic\/claude-sonnet-4/)).toBeTruthy();
    expect(screen.getByText(/decisione: allow/)).toBeTruthy();
    expect(runsMock).toHaveBeenCalledWith("soc", "Z:/repo");
  });

  it("renders awaiting_approval and relogin_required as states, never errors", async () => {
    runsMock.mockResolvedValue({
      id: "soc",
      runs: [
        { ...COMPLETED, runId: "b", status: "awaiting_approval", exitCode: 4, posts: [] },
        { ...COMPLETED, runId: "c", status: "relogin_required", exitCode: 4, posts: [] },
      ],
    });
    renderCard();

    expect(await screen.findByText("in attesa")).toBeTruthy();
    expect(screen.getByText("ri-login richiesto")).toBeTruthy();
    // exit 4 is a STATE chip, not a red error → two neutral badges.
    expect(screen.getAllByText("exit 4 · non provato")).toHaveLength(2);
    expect(screen.queryByText(/errore/i)).toBeNull();
  });

  it("shows an empty state when there are no runs", async () => {
    runsMock.mockResolvedValue({ id: "soc", runs: [] });
    renderCard();
    expect(await screen.findByText("Nessuna esecuzione registrata.")).toBeTruthy();
  });

  it("renders nothing when no automation is selected", () => {
    renderCard(null);
    expect(runsMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/Cronologia/)).toBeNull();
  });

  it("surfaces a load failure as a warn chip", async () => {
    runsMock.mockRejectedValue('{"message":"boom","exitCode":1}');
    renderCard();
    expect(await screen.findByText(/boom \(exit 1\)/)).toBeTruthy();
  });
});

describe("chip helpers", () => {
  it("exitBadge never paints exit 4 as a failure", () => {
    expect(exitBadge(0)).toEqual({ tone: "ok", label: "exit 0" });
    expect(exitBadge(4)).toEqual({ tone: "neutral", label: "exit 4 · non provato" });
    expect(exitBadge(1)).toEqual({ tone: "warn", label: "exit 1" });
  });

  it("runStatusChip maps the known states and falls back for unknown ones", () => {
    expect(runStatusChip("completed").tone).toBe("ok");
    expect(runStatusChip("skipped").label).toBe("saltato");
    expect(runStatusChip("weird").tone).toBe("neutral");
  });
});
