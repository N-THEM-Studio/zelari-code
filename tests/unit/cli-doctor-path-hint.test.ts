/**
 * cli-doctor-path-hint.test.ts — verifies the checkPath() hint points users
 * to `zelari-code --fix-path` on Windows (v1.4.2).
 *
 * checkPath() is not exported from doctor.ts, so we test through runDoctor()
 * — the public surface — and assert on console.log output. This is a
 * behaviour test (what the user actually sees), which is more valuable than
 * asserting on an internal function's return value.
 *
 * Mocking: `node:child_process.spawnSync`/`execSync` are mocked so the
 * platform/prefix probes are deterministic and don't touch the real shell.
 * `node:fs` is partially mocked to fake the shim + bundle presence so the
 * rest of runDoctor passes (we only care about the PATH line here).
 *
 * Cases:
 *   - win32, prefix NOT on PATH → output mentions `--fix-path`
 *   - win32, prefix ON PATH → output says "PATH includes npm prefix"
 *   - darwin, prefix NOT on PATH → output mentions `export PATH` (not --fix-path)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type Scenario = {
  platform?: NodeJS.Platform;
  prefix?: string;
  /** What process.env.PATH holds during the run. */
  processPath?: string;
};

let scenario: Scenario = {};

vi.mock("node:child_process", () => ({
  execSync: vi.fn((cmd: string) => {
    // `npm prefix -g` — return the scenario prefix.
    if (cmd.includes("prefix")) return scenario.prefix ?? "";
    // `node --version` probe.
    if (cmd.includes("node --version")) return "v20.11.1";
    return "";
  }),
  spawnSync: vi.fn(() => ({ stdout: "", status: 0 })),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:fs");
  return {
    ...actual,
    // Pretend the shim + bundle exist so their checks pass.
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn((p: unknown) => {
      // Shim content probe: must reference the package name + bin path.
      if (typeof p === "string" && p.includes("zelari-code.cmd")) {
        return "node_modules\\zelari-code\\bin\\zelari-code.js";
      }
      if (typeof p === "string" && p.endsWith("package.json")) {
        return JSON.stringify({ name: "zelari-code", version: "1.4.2" });
      }
      return "";
    }),
    statSync: vi.fn(() => ({ size: 1024, isFile: () => true })),
    readlinkSync: vi.fn(() => {
      throw new Error("not a symlink");
    }),
  };
});

const REAL_PLATFORM = process.platform;
const REAL_ENV = { ...process.env };

async function importFresh() {
  vi.resetModules();
  return (await import("../../src/cli/utils/doctor.js")) as typeof import("../../src/cli/utils/doctor.js");
}

function applyScenario(s: Scenario) {
  scenario = s;
  Object.defineProperty(process, "platform", {
    value: s.platform ?? REAL_PLATFORM,
    configurable: true,
  });
  process.env = { ...REAL_ENV };
  if (s.prefix !== undefined) {
    process.env.npm_config_prefix = s.prefix;
  }
  process.env.PATH = s.processPath ?? "";
}

let logs: string[] = [];

beforeEach(() => {
  scenario = {};
  logs = [];
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
  process.env = { ...REAL_ENV };
  vi.restoreAllMocks();
});

describe("doctor checkPath() hint — win32 points to --fix-path", () => {
  it("win32 + prefix NOT on PATH → output suggests `zelari-code --fix-path`", async () => {
    const prefix = "C:\\Users\\me\\AppData\\Roaming\\npm";
    applyScenario({
      platform: "win32",
      prefix,
      processPath: "C:\\Windows\\System32;C:\\Program Files\\nodejs",
    });
    const { runDoctor } = await importFresh();
    runDoctor();
    const pathLine = logs.find((l) => l.includes("PATH")) ?? "";
    // Either the OK or WARN PATH line must mention --fix-path on failure.
    const output = logs.join("\n");
    expect(output).toMatch(/zelari-code --fix-path/);
  });

  it("win32 + prefix ON PATH → output reports PATH OK, no --fix-path hint", async () => {
    const prefix = "C:\\Users\\me\\AppData\\Roaming\\npm";
    applyScenario({
      platform: "win32",
      prefix,
      processPath: `C:\\Windows\\System32;${prefix}`,
    });
    const { runDoctor } = await importFresh();
    runDoctor();
    const output = logs.join("\n");
    expect(output).toMatch(/PATH includes npm prefix/);
    // No --fix-path hint when PATH is fine.
    expect(output).not.toMatch(/zelari-code --fix-path/);
  });

  it("POSIX + prefix NOT on PATH → output suggests `export PATH`, NOT --fix-path", async () => {
    // --fix-path is Windows-only; the POSIX hint must keep pointing at
    // the manual export command, never at the (no-op) CLI flag.
    applyScenario({
      platform: "darwin",
      prefix: "/usr/local",
      processPath: "/usr/bin:/bin",
    });
    const { runDoctor } = await importFresh();
    runDoctor();
    const output = logs.join("\n");
    expect(output).toMatch(/export PATH/);
    expect(output).not.toMatch(/zelari-code --fix-path/);
  });
});
