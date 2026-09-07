// @vitest-environment jsdom
/**
 * t62 acceptance: completed project tasks re-appear ONLY when they carry
 * a hygiene flag ('reopened' / 'stale'), with a badge; a clean completed
 * task stays hidden history. In-progress tasks are unaffected.
 *
 * 2.35: the surface is COLLAPSED behind one launcher pill by default —
 * content tests expand it first; the launcher itself has its own case.
 *
 * vi.mock('react'): apps/desktop has its own node_modules copy of React
 * (npm --prefix install), while @testing-library/react at the root uses
 * the root copy — two Reacts in one module graph break hooks. The mock
 * pins every component in this graph to the root copy.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveTasksPanel } from "./LiveTasksPanel";
import type { LiveTask } from "../liveTasks/types";

vi.mock("react", async () => {
  // Direct .js import on purpose: it must resolve to the ROOT React copy
  // regardless of the nested apps/desktop/node_modules install. The bare
  // specifier would pick the desktop copy and break hooks.
  // @ts-expect-error tsc: importing the runtime entry loses type info by design
  return await import("../../../../node_modules/react/index.js");
});

afterEach(() => {
  cleanup();
  // The collapse state persists in localStorage — reset it or later tests
  // start expanded and the launcher button is never rendered.
  localStorage.clear();
});

function projectTask(p: Partial<LiveTask> & Pick<LiveTask, "id" | "content">): LiveTask {
  return { status: "completed", source: "project", ...p } as LiveTask;
}

/** Fresh jsdom localStorage → collapsed default; open the card once. */
function renderExpanded(ui: ReactElement): void {
  render(ui);
  fireEvent.click(screen.getByTitle("Apri il riquadro task e todo"));
}

describe("LiveTasksPanel launcher (2.35)", () => {
  it("is collapsed by default: calendar fab, no task text", () => {
    render(
      <LiveTasksPanel
        tasks={[{ id: "s1", content: "Compito di sessione", status: "in_progress" } as LiveTask]}
        projectTasks={[projectTask({ id: "t9", content: "Task nascosto", status: "pending" })]}
      />,
    );
    expect(screen.getByTitle("Apri il riquadro task e todo")).toBeTruthy();
    expect(screen.queryByText("Compito di sessione")).toBeNull();
    expect(screen.queryByText("Task nascosto")).toBeNull();
  });

  it("animates (is-working) with a badge count only while tasks are active", () => {
    const { rerender } = render(
      <LiveTasksPanel
        tasks={[{ id: "s1", content: "Attivo", status: "in_progress" } as LiveTask]}
        projectTasks={[projectTask({ id: "p1", content: "Bloccato", status: "blocked" })]}
      />,
    );
    const fab = screen.getByTitle("Apri il riquadro task e todo");
    expect(fab.className).toContain("is-working");
    expect(screen.getByText("2")).toBeTruthy(); // 1 in_progress + 1 blocked

    rerender(
      <LiveTasksPanel
        tasks={[{ id: "s1", content: "Fatto", status: "completed" } as LiveTask]}
        projectTasks={[]}
      />,
    );
    const idle = screen.getByTitle("Apri il riquadro task e todo");
    expect(idle.className).not.toContain("is-working");
    expect(screen.queryByText("1")).toBeNull();
  });

  it("expands into the narrow card with session + project rows and the progress bar", () => {
    renderExpanded(
      <LiveTasksPanel
        tasks={[{ id: "s1", content: "Compito di sessione", status: "in_progress" } as LiveTask]}
        projectTasks={[
          projectTask({ id: "p1", content: "Fatto", status: "completed" }),
          projectTask({ id: "p2", content: "Da fare", status: "pending" }),
        ]}
      />,
    );
    expect(screen.getByText("Compito di sessione")).toBeTruthy();
    expect(screen.getByText("Da fare")).toBeTruthy();
    expect(screen.getByLabelText("Piano 50%")).toBeTruthy();
  });
});

describe("LiveTasksPanel project badges (t62)", () => {
  it("completed + reopened is VISIBLE with the riaperto badge", () => {
    renderExpanded(
      <LiveTasksPanel
        tasks={[]}
        projectTasks={[projectTask({ id: "t1", content: "Task riaperto", flags: ["reopened"] })]}
      />,
    );
    expect(screen.getByText("Task riaperto")).toBeTruthy();
    expect(screen.getByText("⚠︎ riaperto")).toBeTruthy();
  });

  it("completed + stale is VISIBLE with the stale badge", () => {
    renderExpanded(
      <LiveTasksPanel
        tasks={[]}
        projectTasks={[projectTask({ id: "t2", content: "Task stantio", flags: ["stale"] })]}
      />,
    );
    expect(screen.getByText("Task stantio")).toBeTruthy();
    expect(screen.getByText("⧗ stale")).toBeTruthy();
  });

  it("clean completed task stays HIDDEN", () => {
    render(
      <LiveTasksPanel
        tasks={[]}
        projectTasks={[projectTask({ id: "t3", content: "Task pulito" })]}
      />,
    );
    expect(screen.queryByText("Task pulito")).toBeNull();
    expect(screen.queryByLabelText("Workspace project tasks")).toBeNull();
  });

  it("completed with unrelated flags (overlap) stays hidden", () => {
    render(
      <LiveTasksPanel
        tasks={[]}
        projectTasks={[projectTask({ id: "t4", content: "Task overlap", flags: ["overlap"] })]}
      />,
    );
    expect(screen.queryByText("Task overlap")).toBeNull();
  });

  it("in_progress tasks render regardless of flags", () => {
    renderExpanded(
      <LiveTasksPanel
        tasks={[]}
        projectTasks={[
          projectTask({ id: "t5", content: "Task attivo", status: "in_progress" }),
        ]}
      />,
    );
    expect(screen.getByText("Task attivo")).toBeTruthy();
  });
});
