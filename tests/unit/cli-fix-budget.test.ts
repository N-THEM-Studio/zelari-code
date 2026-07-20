/**
 * cli-fix-budget.test.ts — tests for `zelari-code --fix-budget` (repairWindowsBudget).
 *
 * Covers the Windows-only budget repair introduced in v1.20.0. Mirrors the
 * pattern of cli-fix-path.test.ts: pure-branching on process.platform +
 * PowerShell round-trip, mocked via per-test scenario.
 *
 * Cases:
 *   - Windows, all vars unset → 3 PowerShell writes invoked → ok:true, applied:3
 *   - Windows, all vars already at target → no writes, ok:true, alreadyOk:true
 *   - Windows, mixed (some set, some not) → only missing ones written
 *   - Windows, write fails (re-read returns old value) → ok:false
 *   - POSIX → ok:false, advisory "Windows-only" message
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---- Per-test scenario, read by the mock factory. ----
type Scenario = {
  platform?: NodeJS.Platform;
  /** Map of var name → current User-scope value (undefined = unset). */
  currentValues?: Record<string, string>;
  /** Map of var name → value returned on re-read after write (defaults to target). */
  rereadValues?: Record<string, string>;
  /** Status returned by ALL spawnSync calls (0 = success). */
  spawnStatus?: number;
};

let scenario: Scenario = {};

// Tracks how many GetEnvironmentVariable calls we've seen so the mock can
// distinguish the initial read from the post-write re-read (same var name).
const getCallCounts: Record<string, number> = {};

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn((cmd: string, args: string[]) => {
    const script = (args[args.length - 1] as string) ?? "";
    // GetEnvironmentVariable('<NAME>','User') — called twice per var: read + re-read.
    const getMatch = script.match(/GetEnvironmentVariable\('([^']+)','User'\)/);
    if (getMatch) {
      const name = getMatch[1];
      getCallCounts[name] = (getCallCounts[name] ?? 0) + 1;
      // First call → current value; second call (after write) → reread value.
      if (getCallCounts[name] === 1) {
        return {
          stdout: scenario.currentValues?.[name] ?? "",
          status: scenario.spawnStatus ?? 0,
        };
      }
      // Re-read defaults to the value we tried to write (extracted from the
      // SetEnvironmentVariable call that precedes this re-read).
      return {
        stdout:
          scenario.rereadValues?.[name] ??
          extractSetValue(script, name) ??
          "",
        status: scenario.spawnStatus ?? 0,
      };
    }
    // SetEnvironmentVariable('<NAME>', '"value"', 'User') — success is silent.
    return { stdout: "", status: scenario.spawnStatus ?? 0 };
  }),
}));

/** Pull the target value out of a SetEnvironmentVariable script string. */
function extractSetValue(_script: string, _name: string): string | undefined {
  // The previous spawnSync call was the SetEnvironmentVariable; we don't
  // track it here. Instead the scenario provides rereadValues explicitly
  // when it wants to simulate a write failure. Default to the recommended
  // values so the success path works without extra setup.
  const recommended: Record<string, string> = {
    ZELARI_MAX_TOOL_LOOP_HARD: "180",
    ZELARI_MAX_TOOL_LOOP_ITERATIONS: "60",
    ZELARI_CONTEXT_LIMIT: "400000",
  };
  return recommended[_name];
}

const REAL_PLATFORM = process.platform;

async function importFresh() {
  vi.resetModules();
  return (await import("../../src/cli/utils/fixBudget.js")) as typeof import("../../src/cli/utils/fixBudget.js");
}

function applyScenario(s: Scenario) {
  scenario = s;
  Object.defineProperty(process, "platform", {
    value: s.platform ?? REAL_PLATFORM,
    configurable: true,
  });
}

beforeEach(() => {
  scenario = {};
  for (const k of Object.keys(getCallCounts)) delete getCallCounts[k];
  vi.clearAllMocks();
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
});

describe("repairWindowsBudget — Windows branch", () => {
  it("writes all three vars when none are set", async () => {
    applyScenario({ platform: "win32", currentValues: {} });
    const { repairWindowsBudget } = await importFresh();
    const r = repairWindowsBudget();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.alreadyOk).toBe(false);
    expect(r.applied).toHaveLength(3);
    expect(r.applied.sort()).toEqual([
      "ZELARI_CONTEXT_LIMIT",
      "ZELARI_MAX_TOOL_LOOP_HARD",
      "ZELARI_MAX_TOOL_LOOP_ITERATIONS",
    ]);
    expect(r.skipped).toEqual([]);
  });

  it("skips all vars when they are already at the recommended values", async () => {
    applyScenario({
      platform: "win32",
      currentValues: {
        ZELARI_MAX_TOOL_LOOP_HARD: "180",
        ZELARI_MAX_TOOL_LOOP_ITERATIONS: "60",
        ZELARI_CONTEXT_LIMIT: "400000",
      },
    });
    const { repairWindowsBudget } = await importFresh();
    const r = repairWindowsBudget();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.alreadyOk).toBe(true);
    expect(r.applied).toEqual([]);
    expect(r.skipped).toHaveLength(3);
  });

  it("writes only the missing var when two are already set", async () => {
    applyScenario({
      platform: "win32",
      currentValues: {
        ZELARI_MAX_TOOL_LOOP_HARD: "180",
        ZELARI_MAX_TOOL_LOOP_ITERATIONS: "60",
        // ZELARI_CONTEXT_LIMIT intentionally absent
      },
    });
    const { repairWindowsBudget } = await importFresh();
    const r = repairWindowsBudget();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.applied).toEqual(["ZELARI_CONTEXT_LIMIT"]);
    expect(r.skipped).toHaveLength(2);
  });

  it("writes a var even when its current value differs from the target", async () => {
    applyScenario({
      platform: "win32",
      currentValues: {
        ZELARI_MAX_TOOL_LOOP_HARD: "90", // old default, below recommended
        ZELARI_MAX_TOOL_LOOP_ITERATIONS: "60",
        ZELARI_CONTEXT_LIMIT: "400000",
      },
    });
    const { repairWindowsBudget } = await importFresh();
    const r = repairWindowsBudget();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.applied).toEqual(["ZELARI_MAX_TOOL_LOOP_HARD"]);
    expect(r.skipped).toHaveLength(2);
  });

  it("fails when PowerShell write does not take effect (re-read returns old value)", async () => {
    applyScenario({
      platform: "win32",
      currentValues: {
        ZELARI_MAX_TOOL_LOOP_HARD: "90",
        ZELARI_MAX_TOOL_LOOP_ITERATIONS: "60",
        ZELARI_CONTEXT_LIMIT: "400000",
      },
      // Simulate the write failing: re-read returns the OLD value, not the target.
      rereadValues: { ZELARI_MAX_TOOL_LOOP_HARD: "90" },
    });
    const { repairWindowsBudget } = await importFresh();
    const r = repairWindowsBudget();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/did not take effect/);
  });
});

describe("repairWindowsBudget — POSIX branch", () => {
  it("returns an advisory error on non-Windows platforms", async () => {
    applyScenario({ platform: "linux" });
    const { repairWindowsBudget } = await importFresh();
    const r = repairWindowsBudget();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/Windows-only/);
    expect(r.error).toMatch(/ZELARI_MAX_TOOL_LOOP_HARD=180/);
    expect(r.error).toMatch(/~\/\.bashrc/);
  });

  it("advisory error mentions all three variables", async () => {
    applyScenario({ platform: "darwin" });
    const { repairWindowsBudget } = await importFresh();
    const r = repairWindowsBudget();
    if (r.ok) return;
    expect(r.error).toMatch(/ZELARI_MAX_TOOL_LOOP_HARD/);
    expect(r.error).toMatch(/ZELARI_MAX_TOOL_LOOP_ITERATIONS/);
    expect(r.error).toMatch(/ZELARI_CONTEXT_LIMIT/);
  });
});
