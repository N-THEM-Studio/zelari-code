import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCouncilCompletion,
  writeCouncilCompletion,
} from "../../packages/core/src/council/completion/index.js";
import type { VerificationReport } from "../../packages/core/src/council/verification/types.js";

const FAIL_REPORT: VerificationReport = {
  ok: false,
  generatedAt: "2026-01-01T00:00:00.000Z",
  runMode: "implementation",
  targets: ["index.html"],
  results: [
    {
      id: "motion.transitions",
      severity: "error",
      ok: false,
      tier: "grep",
      message: 'transition animates non-allowed property "box-shadow"',
    },
    {
      id: "plan.reality",
      severity: "warn",
      ok: false,
      tier: "grep",
      message: "Milestone mentions print but target file(s) do not contain it",
    },
  ],
};

describe("buildCouncilCompletion", () => {
  it("sets readyToCommit false when blocking errors exist", () => {
    const c = buildCouncilCompletion({
      verification: { ran: true, ok: false, report: FAIL_REPORT },
      smoke: { ran: true, ok: true, script: "typecheck" },
      degradedRun: false,
    });
    expect(c.readyToCommit).toBe(false);
    expect(c.ok).toBe(false);
    expect(c.blocking).toContain("motion.transitions");
    expect(c.blocking).not.toContain("plan.reality");
    expect(c.openFails).toHaveLength(2);
  });

  it("sets readyToCommit false when degraded", () => {
    const c = buildCouncilCompletion({
      verification: {
        ran: true,
        ok: true,
        report: { ...FAIL_REPORT, ok: true, results: [] },
      },
      degradedRun: true,
      degradedReasons: ["council aborted"],
    });
    expect(c.readyToCommit).toBe(false);
    expect(c.degraded).toBe(true);
  });

  it("sets readyToCommit true when verify and smoke pass", () => {
    const c = buildCouncilCompletion({
      verification: {
        ran: true,
        ok: true,
        report: { ...FAIL_REPORT, ok: true, results: [] },
      },
      smoke: { ran: true, ok: true, script: "typecheck" },
    });
    expect(c.readyToCommit).toBe(true);
    expect(c.ok).toBe(true);
  });

  it("includes scope when provided", () => {
    const c = buildCouncilCompletion({
      verification: {
        ran: true,
        ok: true,
        report: { ...FAIL_REPORT, ok: true, results: [] },
      },
      scope: {
        targets: ["index.html"],
        keywords: ["animate"],
        explicitOut: ["command palette"],
        nfrRelevant: true,
        sources: ["userMessage"],
      },
    });
    expect(c.scope?.targets).toEqual(["index.html"]);
    expect(c.scope?.explicitOut).toContain("command palette");
  });

  it("blocks readyToCommit when smoke fails", () => {
    const c = buildCouncilCompletion({
      verification: {
        ran: true,
        ok: true,
        report: { ...FAIL_REPORT, ok: true, results: [] },
      },
      smoke: { ran: true, ok: false, script: "typecheck", exitCode: 1 },
    });
    expect(c.readyToCommit).toBe(false);
  });
});

describe("writeCouncilCompletion", () => {
  it("writes JSON to zelari root", () => {
    const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const dir = mkdtempSync(join(tmpdir(), "zelari-completion-"));
    try {
      const c = buildCouncilCompletion({
        verification: { ran: true, ok: false, report: FAIL_REPORT },
      });
      const path = writeCouncilCompletion(dir, c);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.readyToCommit).toBe(false);
      expect(parsed.blocking).toContain("motion.transitions");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
