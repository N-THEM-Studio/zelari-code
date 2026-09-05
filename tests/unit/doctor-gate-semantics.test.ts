/**
 * doctor-gate-semantics.test.ts — pins the DoctorReport gate contract:
 * only critical failures make the report unhealthy. WARN entries stay
 * visible in `entries` but never block (Desktop first-run gate, TUI
 * wizard, `--doctor --json` exit code all consume this verdict).
 *
 * Regression: `collectDoctorReport` used `healthy: entries.every(ok)`,
 * so informational WARNs ("context growth: no instrumented runs yet",
 * optional plugins, cua-driver, budget hints) closed the Desktop front
 * door with no fix command — while plain `--doctor` exited 0 (its exit
 * code only counts criticalFails). The two surfaces disagreed.
 */
import { describe, it, expect } from "vitest";
import { firstBlockingRed, type DoctorEntry } from "../../src/cli/utils/doctor.js";

const ok = (name: string): DoctorEntry => ({
  name,
  ok: true,
  severity: "none",
  message: "fine",
});
const warn = (name: string): DoctorEntry => ({
  name,
  ok: false,
  severity: "warn",
  message: "advisory",
});
const critical = (name: string): DoctorEntry => ({
  name,
  ok: false,
  severity: "critical",
  message: "broken",
});

describe("firstBlockingRed (doctor gate semantics)", () => {
  it("all-OK report is healthy", () => {
    const entries = [ok("node"), ok("PATH"), ok("budget")];
    expect(firstBlockingRed(entries)).toBeNull();
  });

  it("WARN-only report is healthy (informational checks never gate)", () => {
    const entries = [
      ok("node"),
      warn("budget"),
      warn("context growth"),
      warn("plugins"),
      warn("cua-driver"),
    ];
    const firstRed = firstBlockingRed(entries);
    expect(firstRed).toBeNull(); // healthy — Desktop/wizard gate stays open
    // The warns are still in entries for display.
    expect(entries.filter((e) => !e.ok)).toHaveLength(4);
  });

  it("a critical failure blocks, even after warns", () => {
    const entries = [ok("node"), warn("plugins"), critical("PATH")];
    const firstRed = firstBlockingRed(entries);
    expect(firstRed?.name).toBe("PATH");
  });

  it("first critical wins when several are present", () => {
    const entries = [critical("node"), ok("PATH"), critical("cli bundle")];
    expect(firstBlockingRed(entries)?.name).toBe("node");
  });
});
