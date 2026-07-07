/**
 * postinstall-repair-path.test.ts — tests for repairWindowsPath() in
 * scripts/repair-path.mjs (extracted from postinstall.mjs in v1.4.2).
 *
 * repair-path.mjs is a PURE module (no install-time side effects), so we can
 * import it directly without guarding the postinstall main block. Mock
 * pattern follows tests/unit/cli-prereqChecks.test.ts: vi.mock('node:child_process')
 * with a per-test scenario.
 *
 * Contract under test (mirrors src/cli/utils/fixPath.ts):
 *   - Windows + prefix absent → write invoked, re-read confirms → true
 *   - Windows + prefix already present (exact match) → no write → false
 *   - Windows + substring-only match (C:\npm vs C:\npm-cache) → still writes → true
 *   - ZELARI_NO_PATH_REPAIR=1 → false, no spawn
 *   - non-win32 → false, no spawn
 *   - empty prefix → false, no spawn
 *   - write "succeeds" but prefix absent on re-read → false (write didn't stick)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type Scenario = {
  platform?: NodeJS.Platform;
  /** First GetEnvironmentVariable('Path','User') call result. */
  userPath?: string;
  /** Re-read after write (defaults to prefix appended). */
  reread?: string;
  /** Status returned by spawnSync for the read calls. */
  readStatus?: number;
};

let scenario: Scenario = {};
// Track GetEnvironmentVariable call count to distinguish read vs re-read.
let getCount = 0;
let lastWriteScript: string | null = null;

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn((_cmd: string, args: string[]) => {
    const script = (args[args.length - 1] as string) ?? "";
    if (script.includes("GetEnvironmentVariable('Path','User')")) {
      getCount += 1;
      if (getCount === 1) {
        return {
          stdout: scenario.userPath ?? "",
          status: scenario.readStatus ?? 0,
        };
      }
      return {
        stdout: scenario.reread ??
          `${scenario.userPath ?? ""};C:\\Users\\me\\AppData\\Roaming\\npm`,
        status: scenario.readStatus ?? 0,
      };
    }
    if (script.includes("SetEnvironmentVariable")) {
      lastWriteScript = script;
      return { stdout: "", status: 0 };
    }
    return { stdout: "", status: 0 };
  }),
}));

const REAL_PLATFORM = process.platform;
const REAL_ENV = { ...process.env };

async function importFresh() {
  vi.resetModules();
  getCount = 0;
  lastWriteScript = null;
  return (await import("../../scripts/repair-path.mjs")) as {
    repairWindowsPath: (prefix: string) => boolean;
  };
}

function applyScenario(s: Scenario) {
  scenario = s;
  Object.defineProperty(process, "platform", {
    value: s.platform ?? REAL_PLATFORM,
    configurable: true,
  });
  delete process.env.ZELARI_NO_PATH_REPAIR;
}

beforeEach(() => {
  scenario = {};
  getCount = 0;
  lastWriteScript = null;
  vi.clearAllMocks();
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
  process.env = { ...REAL_ENV };
});

describe("repairWindowsPath (scripts/repair-path.mjs)", () => {
  it("appends the prefix when absent from the user PATH", async () => {
    applyScenario({
      platform: "win32",
      userPath: "C:\\Windows\\System32;C:\\Program Files\\nodejs",
    });
    const { repairWindowsPath } = await importFresh();
    const result = repairWindowsPath("C:\\Users\\me\\AppData\\Roaming\\npm");
    expect(result).toBe(true);
    expect(lastWriteScript).not.toBeNull();
    expect(lastWriteScript).toContain("SetEnvironmentVariable");
  });

  it("is idempotent: no write when the prefix is already an exact entry", async () => {
    const prefix = "C:\\Users\\me\\AppData\\Roaming\\npm";
    applyScenario({
      platform: "win32",
      userPath: `C:\\Windows;${prefix}`,
    });
    const { repairWindowsPath } = await importFresh();
    const result = repairWindowsPath(prefix);
    expect(result).toBe(false);
    expect(lastWriteScript).toBeNull();
  });

  it("rejects substring false-positives (C:\\npm vs C:\\npm-cache)", async () => {
    applyScenario({
      platform: "win32",
      userPath: "C:\\npm-cache",
      // After-write re-read: prefix is now appended as its own entry.
      reread: "C:\\npm-cache;C:\\npm",
    });
    const { repairWindowsPath } = await importFresh();
    const result = repairWindowsPath("C:\\npm");
    expect(result).toBe(true);
    expect(lastWriteScript).not.toBeNull();
  });

  it("normalizes path separators, case, and trailing slashes", async () => {
    // Existing entry differs only in case + trailing slash → must match.
    applyScenario({
      platform: "win32",
      userPath: "c:\\users\\me\\appdata\\roaming\\npm\\;C:\\Windows",
    });
    const { repairWindowsPath } = await importFresh();
    const result = repairWindowsPath("C:\\Users\\me\\AppData\\Roaming\\npm");
    expect(result).toBe(false);
    expect(lastWriteScript).toBeNull();
  });

  it("respects ZELARI_NO_PATH_REPAIR=1 (opt-out)", async () => {
    applyScenario({ platform: "win32", userPath: "" });
    process.env.ZELARI_NO_PATH_REPAIR = "1";
    const { repairWindowsPath } = await importFresh();
    const result = repairWindowsPath("C:\\npm");
    expect(result).toBe(false);
    expect(lastWriteScript).toBeNull();
  });

  it("is a no-op on non-win32 platforms", async () => {
    applyScenario({ platform: "darwin", userPath: "/usr/bin" });
    const { repairWindowsPath } = await importFresh();
    const result = repairWindowsPath("/usr/local");
    expect(result).toBe(false);
    expect(lastWriteScript).toBeNull();
  });

  it("returns false for empty prefix", async () => {
    applyScenario({ platform: "win32", userPath: "C:\\Windows" });
    const { repairWindowsPath } = await importFresh();
    const result = repairWindowsPath("");
    expect(result).toBe(false);
    expect(lastWriteScript).toBeNull();
  });

  it("returns false when the write does not stick (re-read unchanged)", async () => {
    // Write "succeeds" but the re-read shows the prefix still absent —
    // simulates a silent permission failure or GPO rollback.
    applyScenario({
      platform: "win32",
      userPath: "C:\\Windows",
      reread: "C:\\Windows",
    });
    const { repairWindowsPath } = await importFresh();
    const result = repairWindowsPath("C:\\Users\\me\\AppData\\Roaming\\npm");
    expect(result).toBe(false);
  });

  it("returns false when PowerShell read fails (status != 0)", async () => {
    applyScenario({
      platform: "win32",
      userPath: "",
      readStatus: 1,
      reread: "",
    });
    const { repairWindowsPath } = await importFresh();
    const result = repairWindowsPath("C:\\npm");
    expect(result).toBe(false);
  });
});
