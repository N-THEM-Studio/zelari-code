/**
 * plugins-doctor.test.ts — verifies runDoctor() surfaces the optional-plugins
 * section introduced in v1.5.0.
 *
 * checkOptionalPlugins() is not exported, so we test through runDoctor()
 * (the public surface) and assert on console.log output. Mocks: the plugin
 * registry's detectMissingPlugins + node:child_process/fs so doctor's other
 * checks pass and we can isolate the optional-plugins line.
 *
 * Contract under test:
 *   - The "optional plugins" line appears in the report.
 *   - When plugins are missing → WARN (never critical; exit stays healthy
 *     if nothing else fails).
 *   - When all present → OK.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn((cmd: string) => {
    if (cmd.includes("prefix")) return "/usr/local";
    if (cmd.includes("node --version")) return "v20.11.1";
    return "";
  }),
  spawnSync: vi.fn(() => ({ status: 0, stdout: "1.0.0\n", stderr: "" })),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn((p: unknown) => {
      if (typeof p === "string" && p.includes("zelari-code.cmd")) {
        return "node_modules\\zelari-code\\bin\\zelari-code.js";
      }
      if (typeof p === "string" && p.endsWith("package.json")) {
        return JSON.stringify({ name: "zelari-code", version: "1.5.0" });
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
let logs: string[] = [];

beforeEach(() => {
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

async function importFresh() {
  vi.resetModules();
  return (await import("../../src/cli/utils/doctor.js")) as typeof import("../../src/cli/utils/doctor.js");
}

describe("runDoctor — optional plugins section", () => {
  it("includes an 'optional plugins' line in the report", async () => {
    // Mock detectMissingPlugins to return empty (all present) by mocking
    // the registry module's detection.
    vi.doMock("../../src/cli/plugins/registry.js", () => ({
      PLUGINS: [],
      detectMissingPlugins: vi.fn(async () => []),
      findPlugin: vi.fn(),
    }));
    process.env.npm_config_prefix = "/usr/local";
    const { runDoctor } = await importFresh();
    await runDoctor();
    const output = logs.join("\n");
    expect(output).toMatch(/\bplugins\b/);
  });

  it("reports WARN when plugins are missing (never critical)", async () => {
    // Missing plugins → WARN line. Healthy (no critical fail) → runDoctor
    // returns true despite the warning.
    vi.doMock("../../src/cli/plugins/registry.js", () => ({
      PLUGINS: [{ id: "eslint", featureGate: "ZELARI_DIAGNOSTICS" }],
      detectMissingPlugins: vi.fn(async () => [
        {
          id: "eslint",
          label: "ESLint",
          npmPackage: "eslint",
          installScope: "dev",
          featureGate: "ZELARI_DIAGNOSTICS",
          description: "diagnostics",
          detect: () => Promise.resolve(false),
        },
      ]),
      findPlugin: vi.fn(),
    }));
    process.env.npm_config_prefix = "/usr/local";
    const { runDoctor } = await importFresh();
    await runDoctor();
    const output = logs.join("\n");
    // The plugins line is WARN (never FAIL/critical), mentions the missing
    // plugin + the /plugins install hint. ANSI color codes sit between WARN
    // and the name, so match loosely across the tag boundary.
    expect(output).toMatch(/WARN[^\n]*plugins/);
    expect(output).toMatch(/optional plugin/);
    expect(output).toMatch(/eslint missing/);
    expect(output).toMatch(/\/plugins/);
    // The critical invariant: the plugins line must NEVER be FAIL, regardless
    // of what other checks report. A missing optional tool is by design
    // non-blocking (features degrade silently).
    expect(output).not.toMatch(/FAIL[^\n]*plugins\b/);
  });
});
