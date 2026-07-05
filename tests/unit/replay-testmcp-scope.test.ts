import { existsSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { buildPlanSummary } from "../../src/cli/workspace/workspaceSummary.js";

const TESTMCP = "Z:/EasyPeasy/TESTMCP";
const MOTION_TASK =
  "Rendilo animato: anima index.html con motion compositor-only. Non command palette in questo task.";

describe.skipIf(!existsSync(`${TESTMCP}/index.html`))(
  "TESTMCP replay — plan scope split",
  () => {
    it("puts command palette in backlog, motion tasks in scope", () => {
      const summary = buildPlanSummary(TESTMCP, { userMessage: MOTION_TASK })!;
      expect(summary).toContain("## In scope for this task");
      expect(summary).toContain("## Planned but not requested (backlog)");
      expect(summary).toMatch(/backlog[\s\S]*command palette/i);
      expect(summary).toMatch(/In scope[\s\S]*reduced-motion/i);

      const phase2 = summary.split("## 2. Interactivity")[1] ?? "";
      expect(phase2).not.toContain("Implementare command palette JS vanilla");
    });
  },
);
