/**
 * workspaceSummary.scope.test.ts — "history is not scope" (2026-09-24).
 *
 * Observed bug (this very session's context-update): the "Task scope (this
 * request)" block quoted VERBATIM the notes of a COMPLETED task — t104's
 * "Out of scope per slice 1: dispatchCouncilPrompt (riga 1650), runAgentMis;
 * backlog P2 perf…" — because `buildPlanSummary` serialized the ENTIRE plan
 * (closed tasks included) as `planText` input to `extractTaskScope`.
 *
 * Contract pinned here:
 *   1. notes of CLOSED tasks (done/completed/cancelled) contribute NOTHING to
 *      the scope section — no Targets, no Keywords, no Out-of-scope text;
 *   2. notes of OPEN tasks still contribute exactly as before;
 *   3. the closed task is still counted in the summary line ("N done") —
 *      closing the leak must not hide the task's existence.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPlanSummary } from "./workspaceSummary.js";

const dirs: string[] = [];

function seedFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "scope-hygiene-"));
  dirs.push(root);
  const vault = join(root, ".zelari");
  mkdirSync(vault, { recursive: true });
  writeFileSync(
    join(vault, "plan.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        counter: 902,
        phases: [{ id: "ph-current", title: "Fase corrente", tasks: [] }],
        milestones: [],
        tasks: [
          {
            id: "t900",
            status: "pending",
            priority: "high",
            name: "Feature corrente",
            notes:
              "Lavora su src/cli/workspace/workspaceSummary.ts. Out of scope: legacy-thing-OPEN.",
          },
          {
            id: "t901",
            status: "completed",
            priority: "low",
            name: "Chiuso era v0.10",
            notes:
              "Out of scope per slice 1: dispatchCouncilPrompt (riga 1650), runAgentMis; backlog P2 perf; keywords compositor-only, inline-js<=5120b",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  return root;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, retryDelay: 20, maxRetries: 10 });
    } catch {
      /* Windows AV races on temp dirs are environmental, not product. */
    }
  }
});

describe("buildPlanSummary — closed-task notes never scope a new request", () => {
  it("drops the completed task's notes from the scope section", () => {
    const root = seedFixture();
    const summary = buildPlanSummary(root, {
      userMessage:
        "Continua il lavoro su src/cli/workspace/workspaceSummary.ts per la feature corrente",
    });
    expect(summary).toBeTruthy();

    // The leak: closed-task notes quoted verbatim (targets, keywords, prose).
    expect(summary).not.toContain("dispatchCouncilPrompt");
    expect(summary).not.toContain("runAgentMis");
    expect(summary).not.toContain("compositor-only");
    expect(summary).not.toContain("inline-js");
  });

  it("keeps OPEN task notes and the done-count intact", () => {
    const root = seedFixture();
    const summary = buildPlanSummary(root, {
      userMessage:
        "Continua il lavoro su src/cli/workspace/workspaceSummary.ts per la feature corrente",
    });
    expect(summary).toBeTruthy();

    // Open-task notes still scope the request.
    expect(summary).toContain("legacy-thing-OPEN");
    // The closed task is counted, not hidden (1 open of 2 total).
    expect(summary).toMatch(/1 open, 1 done/);
  });
});
