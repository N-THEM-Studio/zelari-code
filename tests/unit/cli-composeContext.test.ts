/**
 * composeProjectContext — epistemic hygiene: plan is not RAG, design vault
 * is index-only, product tree is present.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeProjectContext } from "../../src/cli/workspace/composeContext.js";

describe("composeProjectContext", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "compose-ctx-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "aura-demo",
        dependencies: { svelte: "^4.0.0" },
      }),
    );
    mkdirSync(join(dir, "aura", "frontend", "src"), { recursive: true });
    writeFileSync(join(dir, "aura", "frontend", "src", "App.svelte"), "<h1/>");
    // Fat design vault (must NOT fully inject).
    const z = join(dir, ".zelari");
    mkdirSync(join(z, "docs"), { recursive: true });
    mkdirSync(join(z, "decisions"), { recursive: true });
    writeFileSync(
      join(z, "plan.json"),
      JSON.stringify({
        phases: [{ id: "p1", name: "Phase 1", order: 1, description: "A".repeat(2000) }],
        tasks: [
          {
            id: "t1",
            name: "Do thing",
            status: "pending",
            priority: "high",
            phaseId: "p1",
          },
        ],
        milestones: [],
      }),
    );
    writeFileSync(
      join(z, "docs", "giant-design.md"),
      "# Design\n" + "X".repeat(50_000),
    );
    writeFileSync(
      join(z, "decisions", "001-proposed.md"),
      "---\nstatus: proposed\n---\n# ADR\n",
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("includes product tree and epistemic banner", () => {
    const c = composeProjectContext({
      mode: "kraken",
      cwd: dir,
      userMessage: "capisci il progetto",
    });
    expect(c.workspaceContext).toMatch(/EPISTEMIC RULES/);
    expect(c.workspaceContext).toMatch(/UNVERIFIED DESIGN|HYPOTHES/i);
    expect(c.workspaceContext).toMatch(/svelte/i);
    expect(c.workspaceContext).toMatch(/aura/);
  });

  it("does not put plan text in ragContext", () => {
    const c = composeProjectContext({
      mode: "kraken",
      cwd: dir,
      userMessage: "implement plan",
    });
    expect(c.ragContext).toBe("");
    expect(c.workspaceContext).toMatch(/Plan ops|DRAFT/i);
    expect(c.workspaceContext).not.toContain("A".repeat(500)); // phase description stripped
  });

  it("injects durable HEAD into ragContext for council/zelari (not plan)", () => {
    const stateDir = join(dir, ".zelari", "state");
    mkdirSync(join(stateDir, "commits"), { recursive: true });
    mkdirSync(join(stateDir, "artifacts", "abc123"), { recursive: true });
    writeFileSync(join(stateDir, "HEAD.json"), JSON.stringify({ id: "abc123" }));
    writeFileSync(
      join(stateDir, "commits", "abc123.json"),
      JSON.stringify({
        id: "abc123",
        label: "verified layer",
        layer: "mission:impl-1",
        verification: { ok: true, ran: true },
        artifactDir: "artifacts/abc123",
      }),
    );
    writeFileSync(
      join(stateDir, "artifacts", "abc123", "discoveries.json"),
      JSON.stringify([
        { id: "d1", kind: "file_change", summary: "added widget.ts", reusable: true },
      ]),
    );

    const c = composeProjectContext({
      mode: "council",
      cwd: dir,
      userMessage: "continue",
    });
    expect(c.ragContext).toMatch(/Durable State/);
    expect(c.ragContext).toMatch(/widget\.ts/);
    expect(c.ragContext).not.toMatch(/A{50}/); // plan phase dump still not in RAG
  });

  it("does not inject full design doc bodies", () => {
    const c = composeProjectContext({
      mode: "kraken",
      cwd: dir,
    });
    expect(c.workspaceContext).not.toContain("X".repeat(1000));
    expect(c.workspaceContext).toMatch(/design vault|docs\//i);
  });

  it("puts memory only in ragContext", () => {
    const c = composeProjectContext({
      mode: "zelari",
      cwd: dir,
      memoryHits: "## Recalled\n1. some fact from last run",
    });
    expect(c.ragContext).toContain("some fact");
    expect(c.ragContext).not.toMatch(/Plan ops/);
  });
});
