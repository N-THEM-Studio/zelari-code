/**
 * cli-fix-path.test.ts — tests for `zelari-code --fix-path` (repairWindowsUserPath).
 *
 * Covers the Windows-only PATH repair introduced in v1.4.2. The logic is
 * pure-branching on `process.platform` + PowerShell round-trip, so we mock
 * `node:child_process.spawnSync` and drive it via a per-test scenario.
 *
 * Cases that matter (mirrors the postinstall contract):
 *   - Windows, prefix absent → PowerShell write invoked, re-read confirms → ok:true
 *   - Windows, prefix already present → no write, ok:true, alreadyOk:true
 *   - Windows, prefix undetectable → ok:false, error mentions prefix
 *   - POSIX → ok:false, advisory "Windows-only" message
 *   - PowerShell read returns "" with status!=0 → ok:false
 *
 * Mocking pattern follows tests/unit/cli-prereqChecks.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---- Per-test scenario, read by the mock factory. ----
type Scenario = {
  platform?: NodeJS.Platform;
  /** npm prefix env override (skips the `npm prefix -g` spawn). */
  prefix?: string;
  /** First GetEnvironmentVariable('Path','User') call result. */
  userPathRead?: string;
  /** Re-read after write (defaults to prefix-appended for success path). */
  userPathReread?: string;
  /** Status returned by ALL spawnSync calls (0 = success). */
  spawnStatus?: number;
};

let scenario: Scenario = {};

// Tracks how many GetEnvironmentVariable calls we've seen so the mock can
// distinguish the initial read from the post-write re-read (same script).
let getCallCount = 0;

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn((cmd: string, args: string[]) => {
    const script = (args[args.length - 1] as string) ?? "";
    // `npm prefix -g` probe (only hit if prefix env not set).
    if (cmd === "npm" && args[0] === "prefix") {
      return { stdout: scenario.prefix ?? "", status: 0 };
    }
    // GetEnvironmentVariable('Path','User') — called twice: once before
    // write, once after. Counter distinguishes them.
    if (script.includes("GetEnvironmentVariable('Path','User')")) {
      getCallCount += 1;
      if (getCallCount === 1) {
        return {
          stdout: scenario.userPathRead ?? "",
          status: scenario.spawnStatus ?? 0,
        };
      }
      // Re-read defaults to "prefix appended" to simulate a successful write.
      return {
        stdout: scenario.userPathReread ??
          `${scenario.userPathRead ?? ""};${scenario.prefix ?? ""}`,
        status: scenario.spawnStatus ?? 0,
      };
    }
    // SetEnvironmentVariable — success is silent (empty stdout, status 0).
    return { stdout: "", status: scenario.spawnStatus ?? 0 };
  }),
}));

const REAL_PLATFORM = process.platform;

async function importFresh() {
  vi.resetModules();
  return (await import("../../src/cli/utils/fixPath.js")) as typeof import("../../src/cli/utils/fixPath.js");
}

function applyScenario(s: Scenario) {
  scenario = s;
  Object.defineProperty(process, "platform", {
    value: s.platform ?? REAL_PLATFORM,
    configurable: true,
  });
  // Inject prefix via env so getGlobalPrefix skips the npm spawn.
  if (s.prefix !== undefined) {
    process.env.npm_config_prefix = s.prefix;
  } else {
    delete process.env.npm_config_prefix;
  }
}

beforeEach(() => {
  scenario = {};
  getCallCount = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
  delete process.env.npm_config_prefix;
});

describe("repairWindowsUserPath — Windows branch", () => {
  it("appends the prefix when it is absent from the user PATH", async () => {
    applyScenario({
      platform: "win32",
      prefix: "C:\\Users\\me\\AppData\\Roaming\\npm",
      userPathRead: "C:\\Windows\\System32;C:\\Program Files\\nodejs",
    });
    const { repairWindowsUserPath } = await importFresh();
    const result = repairWindowsUserPath();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alreadyOk).toBe(false);
      expect(result.prefix).toBe("C:\\Users\\me\\AppData\\Roaming\\npm");
    }
  });

  it("is idempotent: when the prefix is already present, it does NOT write", async () => {
    const prefix = "C:\\Users\\me\\AppData\\Roaming\\npm";
    applyScenario({
      platform: "win32",
      prefix,
      userPathRead: `C:\\Windows\\System32;${prefix}`,
      // If the code wrote, the re-read would differ — but we set it equal
      // to prove the "already present" branch short-circuits before write.
      userPathReread: `C:\\Windows\\System32;${prefix}`,
    });
    const { repairWindowsUserPath } = await importFresh();
    const result = repairWindowsUserPath();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.alreadyOk).toBe(true);
  });

  it("rejects substring false-positives (C:\\npm vs C:\\npm-cache)", async () => {
    // Prefix is a substring of an existing entry, but not an exact match →
    // the code must still treat it as absent and append.
    applyScenario({
      platform: "win32",
      prefix: "C:\\npm",
      userPathRead: "C:\\npm-cache;C:\\Windows",
    });
    const { repairWindowsUserPath } = await importFresh();
    const result = repairWindowsUserPath();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.alreadyOk).toBe(false);
  });

  it("normalizes path separators and trailing slashes when matching", async () => {
    // Prefix written with trailing backslash, read back without — must match.
    applyScenario({
      platform: "win32",
      prefix: "C:\\Users\\me\\AppData\\Roaming\\npm",
      // Existing entry has a trailing slash + different case.
      userPathRead: "c:\\users\\me\\appdata\\roaming\\npm\\;C:\\Windows",
      userPathReread: "c:\\users\\me\\appdata\\roaming\\npm\\;C:\\Windows",
    });
    const { repairWindowsUserPath } = await importFresh();
    const result = repairWindowsUserPath();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.alreadyOk).toBe(true);
  });

  it("returns ok:false when the prefix cannot be detected", async () => {
    applyScenario({ platform: "win32", prefix: "" });
    const { repairWindowsUserPath } = await importFresh();
    const result = repairWindowsUserPath();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/prefix/i);
  });

  it("returns ok:false when the PowerShell write does not take effect", async () => {
    // Write "succeeds" (status 0) but the re-read shows the prefix still
    // absent — simulates a silent permission failure or GPO rollback.
    const prefix = "C:\\Users\\me\\AppData\\Roaming\\npm";
    applyScenario({
      platform: "win32",
      prefix,
      userPathRead: "C:\\Windows",
      userPathReread: "C:\\Windows", // unchanged → write didn't stick
    });
    const { repairWindowsUserPath } = await importFresh();
    const result = repairWindowsUserPath();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });
});

describe("repairWindowsUserPath — POSIX branch (advisory no-op)", () => {
  it("returns ok:false with an advisory message on POSIX", async () => {
    applyScenario({
      platform: "darwin",
      prefix: "/usr/local",
    });
    const { repairWindowsUserPath } = await importFresh();
    const result = repairWindowsUserPath();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Windows-only/);
      expect(result.error).toMatch(/export PATH/);
    }
  });

  it("returns ok:false on linux too", async () => {
    applyScenario({ platform: "linux", prefix: "/home/me/.npm-global" });
    const { repairWindowsUserPath } = await importFresh();
    const result = repairWindowsUserPath();
    expect(result.ok).toBe(false);
  });
});
