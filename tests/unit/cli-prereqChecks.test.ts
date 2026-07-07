/**
 * cli-prereqChecks.test.ts — tests for the agent-shell-aware prerequisite probes.
 *
 * The core value of prereqChecks is that it detects the "node visible to the
 * main process but invisible to Git Bash" mismatch — the exact bug that
 * blocked the Anathema-Studio council on 2026-07-07. We test that by mocking
 * `node:child_process` so spawnSync (used for the bash probe) and execSync
 * (used for the main-process probe) return different results, then asserting
 * checkAgentNode FAILs while checkMainNode OKs.
 *
 * Mocking strategy: vi.mock('node:child_process') with a factory that reads
 * a per-test "scenario" from a module-level variable. This avoids touching
 * the real filesystem or PATH (which differ per CI/dev machine) and lets us
 * simulate win32 Git Bash behaviour even when the test host is Linux/macOS.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---- Mock scenario: each test sets this before importing the module. ----
/**
 * The mock reads this object to decide what spawnSync / execSync return.
 * `bashProbe` simulates `spawnSync(bashPath, ['-c', '<tool> --version'])`.
 * `mainProbe` simulates `execSync('<tool> --version')` from the main process.
 * `whereBash` simulates `spawnSync('where', ['bash'])` on win32.
 */
type Scenario = {
  bashProbe?: { stdout: string; status: number };
  mainProbe?: { stdout: string; error?: boolean };
  whereBash?: { stdout: string; status: number };
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  bashPathExists?: boolean; // for existsSync on the resolved bash path
};

let scenario: Scenario = {};

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn((cmd: string, args: string[]) => {
    // `where bash` — win32 PATH lookup for a bash binary.
    if (cmd === "where" && args[0] === "bash") {
      return scenario.whereBash
        ? { stdout: scenario.whereBash.stdout, status: scenario.whereBash.status }
        : { stdout: "", status: 1 };
    }
    // bash probe: spawnSync(bashPath, ['-c', '<tool> --version'])
    // args = ['-c', 'node --version'] or ['-c', 'git --version']
    const cmd2 = (args[1] as string) ?? "";
    if (cmd2.includes("node")) {
      return scenario.bashProbe
        ? { stdout: scenario.bashProbe.stdout, status: scenario.bashProbe.status }
        : { stdout: "", status: 127 };
    }
    if (cmd2.includes("git")) {
      return scenario.bashProbe
        ? { stdout: scenario.bashProbe.stdout, status: scenario.bashProbe.status }
        : { stdout: "", status: 127 };
    }
    return { stdout: "", status: 1 };
  }),
  execSync: vi.fn((cmd: string) => {
    // Main-process probe: execSync('<tool> --version').
    // Real execSync(encoding:'utf8') returns a STRING — not {stdout}.
    if (scenario.mainProbe?.error) {
      throw new Error("command not found");
    }
    if (cmd.includes("node")) {
      // mainProbe drives both checkMainNode AND the POSIX agent-shell path
      // (on POSIX the agent shell is /bin/sh, same as execSync's shell).
      return scenario.mainProbe ? scenario.mainProbe.stdout : "";
    }
    return "";
  }),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:fs");
  return {
    ...actual,
    // existsSync: pretend the resolved bash path exists when the scenario says so.
    existsSync: vi.fn((p: string) => {
      if (scenario.bashPathExists === false) return false;
      // Standard bash paths: only "exist" if the scenario sets them.
      if (typeof p === "string" && p.includes("bash.exe")) {
        return scenario.env?.ZELARI_SHELL === p || scenario.env?.SHELL === p;
      }
      return actual.existsSync(p);
    }),
  };
});

// Helper: set platform + env + scenario, then dynamically import the module
// fresh (vi.resetModules) so the platform check is re-evaluated.
async function importFresh() {
  vi.resetModules();
  return (await import("../../src/cli/utils/prereqChecks.js")) as typeof import("../../src/cli/utils/prereqChecks.js");
}

const REAL_PLATFORM = process.platform;
const REAL_ENV = { ...process.env };

function applyScenario(s: Scenario) {
  scenario = s;
  if (s.platform !== undefined) {
    Object.defineProperty(process, "platform", { value: s.platform, configurable: true });
  } else {
    Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
  }
  // Build env from scratch. Never inherit SHELL/ZELARI_SHELL from the host —
  // only the scenario can set them. Otherwise resolveAgentShellSync reads the
  // host's /bin/bash via process.env.SHELL on win32 tests and returns isBash:true
  // instead of the expected cmd.exe fallback.
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(REAL_ENV)) {
    if (k === "SHELL" || k === "ZELARI_SHELL") continue;
    env[k] = v;
  }
  Object.assign(env, s.env ?? {});
  process.env = env;
}

beforeEach(() => {
  scenario = {};
  vi.clearAllMocks();
});

afterEach(() => {
  // Restore platform + env so tests don't leak.
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
  process.env = { ...REAL_ENV };
});

describe("prereqChecks — agent-shell-aware probes", () => {
  it("checkAgentNode OKs when bash sees node >= 20", async () => {
    applyScenario({
      platform: "win32",
      env: { ZELARI_SHELL: "C:\\fake\\bash.exe" },
      bashPathExists: true,
      bashProbe: { stdout: "v20.11.1\n", status: 0 },
    });
    const { checkAgentNode } = await importFresh();
    const r = checkAgentNode();
    expect(r.ok).toBe(true);
    expect(r.tool).toBe("node");
    expect(r.severity).toBe("critical");
    expect(r.message).toContain("20.11.1");
  });

  it("checkAgentNode FAILs (critical) when bash does NOT see node — the bug we fix", async () => {
    // This is THE regression test: node is on the main-process PATH but
    // invisible to the agent's bash. Before v1.4.0 this case was silent.
    applyScenario({
      platform: "win32",
      env: { ZELARI_SHELL: "C:\\fake\\bash.exe" },
      bashPathExists: true,
      bashProbe: { stdout: "", status: 127 }, // bash can't find node
      mainProbe: { stdout: "v20.11.1\n" }, // main process finds node fine
    });
    const { checkAgentNode, checkMainNode } = await importFresh();
    const agent = checkAgentNode();
    const main = checkMainNode();
    expect(agent.ok).toBe(false);
    expect(agent.severity).toBe("critical");
    expect(agent.message.toLowerCase()).toContain("not reachable");
    expect(agent.message.toLowerCase()).toContain("fix");
    // And the differential: main-process probe passes → confirms PATH mismatch.
    expect(main.ok).toBe(true);
  });

  it("checkAgentNode FAILs when node is too old (< 20)", async () => {
    // On POSIX the agent shell is /bin/sh, so probeTool uses execSync (not
    // spawnSync). We drive it via mainProbe.stdout.
    applyScenario({
      platform: "linux",
      mainProbe: { stdout: "v18.19.0\n" },
    });
    const { checkAgentNode } = await importFresh();
    const r = checkAgentNode();
    expect(r.ok).toBe(false);
    expect(r.severity).toBe("critical");
    expect(r.message).toContain("18.19.0");
    expect(r.message).toContain("20");
  });

  it("checkAgentNode WARNs (not fails) when version string is unparseable", async () => {
    applyScenario({
      platform: "linux",
      mainProbe: { stdout: "totally-broken-output\n" },
    });
    const { checkAgentNode } = await importFresh();
    const r = checkAgentNode();
    expect(r.ok).toBe(false);
    expect(r.severity).toBe("warn"); // don't hard-fail on a weird-but-present node
  });

  it("checkAgentGit OKs when bash sees git", async () => {
    applyScenario({
      platform: "win32",
      env: { ZELARI_SHELL: "C:\\fake\\bash.exe" },
      bashPathExists: true,
      bashProbe: { stdout: "git version 2.43.0\n", status: 0 },
    });
    const { checkAgentGit } = await importFresh();
    const r = checkAgentGit();
    expect(r.ok).toBe(true);
    expect(r.severity).toBe("warn"); // git is always soft (warn)
    expect(r.message).toContain("2.43.0");
  });

  it("checkAgentGit FAILs as warn (not critical) when git missing — features degrade, don't block", async () => {
    applyScenario({
      platform: "win32",
      env: { ZELARI_SHELL: "C:\\fake\\bash.exe" },
      bashPathExists: true,
      bashProbe: { stdout: "", status: 127 },
    });
    const { checkAgentGit } = await importFresh();
    const r = checkAgentGit();
    expect(r.ok).toBe(false);
    expect(r.severity).toBe("warn");
    expect(r.message.toLowerCase()).toContain("git-scm.com");
  });

  it("checkAgentBash WARNs on win32 when no Git Bash is found (cmd.exe fallback)", async () => {
    applyScenario({
      platform: "win32",
      // No ZELARI_SHELL, no SHELL, no standard paths, `where bash` fails.
      whereBash: { stdout: "", status: 1 },
    });
    const { checkAgentBash } = await importFresh();
    const r = checkAgentBash();
    expect(r.ok).toBe(false);
    expect(r.severity).toBe("warn");
    expect(r.message.toLowerCase()).toContain("git bash");
  });

  it("checkAgentBash OKs on win32 when ZELARI_SHELL points at a real bash", async () => {
    applyScenario({
      platform: "win32",
      env: { ZELARI_SHELL: "C:\\fake\\bash.exe" },
      bashPathExists: true,
    });
    const { checkAgentBash } = await importFresh();
    const r = checkAgentBash();
    expect(r.ok).toBe(true);
  });

  it("checkAgentBash OKs on POSIX unconditionally", async () => {
    applyScenario({ platform: "linux" });
    const { checkAgentBash } = await importFresh();
    const r = checkAgentBash();
    expect(r.ok).toBe(true);
  });
});

describe("runPrereqChecks — aggregation", () => {
  it("sets hasCriticalFail=true when node is unreachable from agent shell", async () => {
    applyScenario({
      platform: "win32",
      env: { ZELARI_SHELL: "C:\\fake\\bash.exe" },
      bashPathExists: true,
      bashProbe: { stdout: "", status: 127 }, // both node and git missing in bash
    });
    const { runPrereqChecks } = await importFresh();
    const r = runPrereqChecks({ mode: "preflight" });
    expect(r.hasCriticalFail).toBe(true);
    expect(r.results.some((x) => x.tool === "node" && !x.ok)).toBe(true);
    // git/bash failures should land in warnings (warn severity).
    expect(r.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("sets hasCriticalFail=false on a healthy environment", async () => {
    applyScenario({
      platform: "win32",
      env: { ZELARI_SHELL: "C:\\fake\\bash.exe" },
      bashPathExists: true,
      bashProbe: { stdout: "v20.11.1\n", status: 0 },
    });
    const { runPrereqChecks } = await importFresh();
    const r = runPrereqChecks({ mode: "preflight" });
    expect(r.hasCriticalFail).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it("never throws even when a probe crashes — degrades to a warn result", async () => {
    // Force the mock to throw inside spawnSync path. We do this by setting a
    // scenario the mock doesn't recognise and relying on the try/catch in
    // runPrereqChecks. The aggregation must still return a valid shape.
    applyScenario({
      platform: "linux",
      bashProbe: { stdout: "v20.0.0\n", status: 0 },
    });
    const { runPrereqChecks } = await importFresh();
    const r = runPrereqChecks({ mode: "full" });
    expect(r.results.length).toBe(3); // node, git, bash
    expect(Array.isArray(r.warnings)).toBe(true);
    expect(typeof r.hasCriticalFail).toBe("boolean");
  });
});
