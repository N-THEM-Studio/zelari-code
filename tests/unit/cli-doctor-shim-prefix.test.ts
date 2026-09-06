/**
 * Doctor bin-shim prefix: `npm run desktop:dev --prefix apps/desktop`
 * sets npm_config_prefix to the desktop package dir. Doctor must still
 * query `npm prefix -g` and must not FAIL-gate a source checkout.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";

const GLOBAL_PREFIX = "C:\\Users\\me\\AppData\\Roaming\\npm";
const LOCAL_PREFIX = "Z:\\EasyPeasy\\zelari-code\\apps\\desktop";

let logs: string[] = [];

vi.mock("node:child_process", () => ({
  execSync: vi.fn((cmd: string) => {
    if (typeof cmd === "string" && cmd.includes("prefix")) return GLOBAL_PREFIX;
    if (typeof cmd === "string" && cmd.includes("node --version")) return "v24.0.0";
    return "";
  }),
  spawnSync: vi.fn(() => ({ stdout: "", status: 0 })),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:fs");
  const norm = (p: unknown) => String(p).replace(/\\/g, "/").toLowerCase();
  return {
    ...actual,
    existsSync: vi.fn((p: unknown) => {
      const n = norm(p);
      if (n.endsWith("/package.json")) return true;
      if (n.endsWith("/src/cli/main.ts")) return true;
      if (n.endsWith("/apps/desktop/package.json")) return true;
      if (n.endsWith("/bin/zelari-code.js")) return true;
      if (n.endsWith("/dist/cli/main.bundled.js")) return true;
      // Global AND local shims are missing — the bug was using LOCAL_PREFIX.
      if (n.endsWith("/zelari-code.cmd") || n.endsWith("/zelari-code")) return false;
      return false;
    }),
    readFileSync: vi.fn((p: unknown) => {
      if (typeof p === "string" && p.endsWith("package.json")) {
        return JSON.stringify({
          name: "zelari-code",
          version: "2.34.0",
          engines: { node: ">=24" },
        });
      }
      return "";
    }),
    statSync: vi.fn(() => ({ size: 1024, isFile: () => true })),
    readlinkSync: vi.fn(() => {
      throw new Error("not a symlink");
    }),
  };
});

const REAL_ENV = { ...process.env };

async function importFresh() {
  vi.resetModules();
  return (await import("../../src/cli/utils/doctor.js")) as typeof import("../../src/cli/utils/doctor.js");
}

beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  process.env = { ...REAL_ENV };
  process.env.npm_config_prefix = LOCAL_PREFIX;
});

afterEach(() => {
  process.env = { ...REAL_ENV };
  vi.restoreAllMocks();
});

describe("doctor bin shim vs npm run --prefix", () => {
  it("does not look for the shim under the local --prefix dir", async () => {
    const { collectDoctorReport } = await importFresh();
    const report = await collectDoctorReport();
    const shim = report.entries.find((e) => e.name === "bin shim");
    expect(shim).toBeTruthy();
    expect(shim!.message).not.toContain(LOCAL_PREFIX);
    expect(shim!.message).not.toMatch(/apps[\\/]desktop[\\/]zelari-code\.cmd/i);
  });

  it("source checkout with a missing global shim is WARN (does not gate)", async () => {
    const { collectDoctorReport, firstBlockingRed } = await importFresh();
    const report = await collectDoctorReport();
    const shim = report.entries.find((e) => e.name === "bin shim");
    expect(shim?.ok).toBe(false);
    expect(shim?.severity).toBe("warn");
    expect(shim?.message).toMatch(/source checkout/i);
    expect(firstBlockingRed(report.entries.filter((e) => e.name === "bin shim"))).toBeNull();
  });

  it("prints the real global prefix, not the desktop package dir", async () => {
    const { runDoctor } = await importFresh();
    await runDoctor();
    const joined = logs.join("\n");
    expect(joined).toContain(GLOBAL_PREFIX);
    expect(joined).not.toMatch(/prefix:\s+.*apps[\\/]desktop/i);
  });
});
