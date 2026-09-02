// @vitest-environment jsdom
/**
 * t62 acceptance: completed project tasks re-appear ONLY when they carry
 * a hygiene flag ('reopened' / 'stale'), with a badge; a clean completed
 * task stays hidden history. In-progress tasks are unaffected.
 *
 * vi.mock('react'): apps/desktop has its own node_modules copy of React
 * (npm --prefix install), while @testing-library/react at the root uses
 * the root copy — two Reacts in one module graph break hooks. The mock
 * pins every component in this graph to the root copy.
 */
import { cleanup, render, screen } from "@testing-library/react";
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

afterEach(cleanup);

function projectTask(p: Partial<LiveTask> & Pick<LiveTask, "id" | "content">): LiveTask {
  return { status: "completed", source: "project", ...p } as LiveTask;
}

describe("LiveTasksPanel project badges (t62)", () => {
  it("completed + reopened is VISIBLE with the riaperto badge", () => {
    render(
      <LiveTasksPanel
        tasks={[]}
        projectTasks={[projectTask({ id: "t1", content: "Task riaperto", flags: ["reopened"] })]}
      />,
    );
    expect(screen.getByText("Task riaperto")).toBeTruthy();
    expect(screen.getByText("⚠︎ riaperto")).toBeTruthy();
  });

  it("completed + stale is VISIBLE with the stale badge", () => {
    render(
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
    render(
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
