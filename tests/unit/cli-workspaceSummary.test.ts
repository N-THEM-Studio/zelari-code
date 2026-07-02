/**
 * cli-workspaceSummary.test.ts — v0.7.2 buildWorkspaceSummary coverage.
 *
 * The council receives this string as `workspaceContext`. Before v0.7.2 it was
 * always empty (the council had no idea which project it was operating on).
 * These tests pin the contract: cwd, project name, tech stack, scripts, and a
 * shallow file listing are present.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWorkspaceSummary,
  buildPlanSummary,
} from "../../src/cli/workspace/workspaceSummary.js";

describe("buildWorkspaceSummary (v0.7.2)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ws-summary-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("includes the working directory and project name", () => {
    const summary = buildWorkspaceSummary(dir);
    expect(summary).toContain(`Working directory: ${dir}`);
    expect(summary).toMatch(/# Project: /);
  });

  it("includes the tech stack from package.json when present", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "demo-shop",
        dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
        devDependencies: { typescript: "^5.7.0" },
      }),
    );
    const summary = buildWorkspaceSummary(dir);
    expect(summary).toContain("react");
    expect(summary).toContain("typescript");
    expect(summary).toMatch(/## Tech stack/);
  });

  it("omits the tech stack section when no package.json", () => {
    const summary = buildWorkspaceSummary(dir);
    expect(summary).not.toMatch(/## Tech stack/);
  });

  it("includes npm scripts when present", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { dev: "vite", build: "tsc && vite build" } }),
    );
    const summary = buildWorkspaceSummary(dir);
    expect(summary).toMatch(/## npm scripts/);
    expect(summary).toContain("`dev`: vite");
    expect(summary).toContain("`build`: tsc && vite build");
  });

  it("lists top-level files and directories (depth 2 peek into subdirs)", () => {
    writeFileSync(join(dir, "README.md"), "# hi");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "App.tsx"), "export const App = () => null");
    writeFileSync(join(dir, "src", "main.tsx"), "");
    const summary = buildWorkspaceSummary(dir);
    expect(summary).toMatch(/## Top-level/);
    expect(summary).toContain("README.md");
    expect(summary).toContain("src/");
    // The src/ peek lists some of its files.
    expect(summary).toMatch(/src\/.*App\.tsx/);
  });

  it("hides dotfiles, node_modules, and dist from the listing", () => {
    writeFileSync(join(dir, ".hidden"), "x");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "pkg.json"), "{}");
    const summary = buildWorkspaceSummary(dir);
    expect(summary).not.toContain(".hidden");
    expect(summary).not.toContain("node_modules");
  });
});

describe("buildPlanSummary (v0.7.3)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plan-summary-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writePlan = (plan: unknown): void => {
    mkdirSync(join(dir, ".zelari"), { recursive: true });
    writeFileSync(join(dir, ".zelari", "plan.json"), JSON.stringify(plan));
  };

  it("returns null when there is no plan.json (fresh project pays no prompt cost)", () => {
    expect(buildPlanSummary(dir)).toBeNull();
  });

  it("returns null for an empty or corrupt plan", () => {
    writePlan({ phases: [], tasks: [], milestones: [] });
    expect(buildPlanSummary(dir)).toBeNull();
    writeFileSync(join(dir, ".zelari", "plan.json"), "{not json");
    expect(buildPlanSummary(dir)).toBeNull();
  });

  it("renders phases with open tasks, task-file pointers, and totals", () => {
    writePlan({
      phases: [
        {
          kind: "phase",
          id: "mvp",
          name: "Phase 1: MVP",
          description: "Ship the basics",
          order: 1,
        },
      ],
      tasks: [
        {
          kind: "task",
          id: "mvp-setup-1",
          name: "Setup entry points",
          phaseId: "mvp",
          status: "pending",
          priority: "high",
        },
        {
          kind: "task",
          id: "mvp-done-2",
          name: "Old task",
          phaseId: "mvp",
          status: "done",
          priority: "low",
        },
      ],
      milestones: [
        {
          kind: "milestone",
          id: "m-v1",
          name: "v1 live",
          targetVersion: "v1.0.0",
        },
      ],
    });
    const summary = buildPlanSummary(dir)!;
    expect(summary).toContain("# Project Plan");
    expect(summary).toContain("Phase 1: MVP");
    expect(summary).toContain("Ship the basics");
    // Open task rendered with its title and the pointer to the detail file.
    expect(summary).toContain(
      "[pending/high] Setup entry points → .zelari/plan-tasks/mvp-setup-1.md",
    );
    // Done tasks are counted, not listed.
    expect(summary).not.toContain("Old task");
    expect(summary).toContain("2 task(s) total — 1 open, 1 done.");
    expect(summary).toContain("v1 live (target: v1.0.0)");
    expect(summary).toContain("read the task file(s)");
  });

  it('lists tasks whose phase is missing under (unassigned)', () => {
    writePlan({
      phases: [],
      tasks: [{ kind: 'task', id: 'orphan-1', name: 'Orphan task', phaseId: 'ghost', status: 'pending' }],
      milestones: [],
    });
    const summary = buildPlanSummary(dir)!;
    expect(summary).toContain('(unassigned)');
    expect(summary).toContain('Orphan task');
  });

  it('v0.7.4: picks "next task" — first in_progress, else by priority', () => {
    writePlan({
      phases: [{ kind: "phase", id: "p1", name: "P1", order: 1 }],
      tasks: [
        {
          kind: "task",
          id: "t-low",
          name: "Low",
          phaseId: "p1",
          status: "pending",
          priority: "low",
        },
        {
          kind: "task",
          id: "t-wip",
          name: "WIP",
          phaseId: "p1",
          status: "in_progress",
          priority: "low",
        },
      ],
      milestones: [],
    });
    const summary = buildPlanSummary(dir)!;
    // First in_progress wins, even when another open task has higher priority.
    expect(summary).toMatch(
      /\*\*Next task to work on:\*\*\s+- WIP \(in_progress\/low\)/,
    );
  });

  it("v0.7.4: fallback to priority when no in_progress", () => {
    writePlan({
      phases: [{ kind: "phase", id: "p1", name: "P1", order: 1 }],
      tasks: [
        {
          kind: "task",
          id: "t-low",
          name: "Low",
          phaseId: "p1",
          status: "pending",
          priority: "low",
        },
        {
          kind: "task",
          id: "t-crit",
          name: "Critical",
          phaseId: "p1",
          status: "pending",
          priority: "critical",
        },
      ],
      milestones: [],
    });
    const summary = buildPlanSummary(dir)!;
    expect(summary).toMatch(
      /\*\*Next task to work on:\*\*\s+- Critical \(pending\/critical\)/,
    );
  });

  it('v0.7.4: omits "Next task" when every task is done', () => {
    writePlan({
      phases: [{ kind: "phase", id: "p1", name: "P1", order: 1 }],
      tasks: [
        {
          kind: "task",
          id: "t-done",
          name: "Done",
          phaseId: "p1",
          status: "done",
          priority: "high",
        },
      ],
      milestones: [],
    });
    const summary = buildPlanSummary(dir)!;
    expect(summary).not.toContain("Next task to work on");
  });
});

describe("buildZelariReadHint (v0.7.4)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zelari-hint-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty string when no plan exists", async () => {
    const { buildZelariReadHint } =
      await import("../../src/cli/workspace/workspaceSummary.js");
    expect(buildZelariReadHint(dir)).toBe("");
  });

  it("returns the read-hint block when a plan exists", async () => {
    mkdirSync(join(dir, ".zelari"), { recursive: true });
    writeFileSync(
      join(dir, ".zelari", "plan.json"),
      JSON.stringify({
        phases: [{ kind: "phase", id: "p1", name: "P1", order: 1 }],
        tasks: [
          {
            kind: "task",
            id: "t1",
            name: "T1",
            phaseId: "p1",
            status: "pending",
          },
        ],
        milestones: [],
      }),
    );
    const { buildZelariReadHint } =
      await import("../../src/cli/workspace/workspaceSummary.js");
    const hint = buildZelariReadHint(dir);
    expect(hint).toContain("# Council workspace detected");
    expect(hint).toContain("list_files");
    expect(hint).toContain("read_file");
    expect(hint).toContain("plan.json");
  });
});
