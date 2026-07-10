/**
 * plugins-registry.test.ts — tests for the plugin catalog + detection.
 *
 * Covers the five plugins (eslint, ruff, playwright, typescript-language-server,
 * pyright) and the detectMissingPlugins aggregator. Detection mocks the
 * underlying primitives (resolveBin for local via existsSync, isBinaryOnPath
 * via PATH + existsSync, loadPlaywright) so tests are deterministic and
 * platform-independent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ---- Per-test scenario, read by the mocks. ----
type Scenario = {
  /** Simulated resolveBin result per binary. Bare name = "not found". */
  localBins?: Record<string, string>;
  /** Simulated playwright loader result. */
  playwrightPresent?: boolean;
};

let scenario: Scenario = {};

// resolveBin is imported from diagnostics/engine.ts which uses existsSync.
// Mock node:fs so resolveBin's existsSync check returns per-scenario.
vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:fs");
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      const str = String(p);
      // resolveBin looks for node_modules/.bin/<bin><suffix>.
      const m = str.match(/[\\/]node_modules[\\/]\.bin[\\/](.+?)(\.cmd|\.exe)?$/);
      if (m) {
        const bin = m[1];
        const resolved = scenario.localBins?.[bin];
        return resolved !== undefined && resolved !== bin;
      }
      // Real existsSync for PATH bins created under tmp dirs in tests.
      return actual.existsSync(p);
    }),
  };
});

// Mock loadPlaywright so detectPlaywright doesn't do a real import.
vi.mock("../../src/cli/browser/driver.js", () => ({
  loadPlaywright: vi.fn(async (_cwd?: string) => {
    return scenario.playwrightPresent === true ? { chromium: { launch: () => {} } } : null;
  }),
  defaultPlaywrightLoader: vi.fn(async () => {
    return scenario.playwrightPresent === true ? { chromium: { launch: () => {} } } : null;
  }),
}));

const REAL_ENV = { ...process.env };

async function importFresh() {
  vi.resetModules();
  return (await import("../../src/cli/plugins/registry.js")) as typeof import("../../src/cli/plugins/registry.js");
}

function applyScenario(s: Scenario) {
  scenario = s;
  // Clear kill-switches + prefs env so each test starts clean.
  delete process.env.ZELARI_BROWSER;
  delete process.env.ZELARI_LSP;
  delete process.env.ZELARI_DIAGNOSTICS;
  process.env.ZELARI_PLUGINS_PREFS_FILE = ""; // isolate prefs (isMuted reads file)
}

/** Create a temp PATH dir with empty shims for the given bare bin names. */
function makePathBins(bins: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "zelari-plugin-path-"));
  for (const bin of bins) {
    // Portable: bare name + .cmd (win32 PATHEXT) so isBinaryOnPath finds them
    // on every platform under our controlled PATH/PATHEXT.
    writeFileSync(path.join(dir, bin), "");
    writeFileSync(path.join(dir, `${bin}.cmd`), "");
  }
  return dir;
}

beforeEach(() => {
  scenario = {};
  vi.clearAllMocks();
  applyScenario({});
});

afterEach(() => {
  process.env = { ...REAL_ENV };
});

describe("PLUGINS catalog", () => {
  it("has the expected plugins with stable ids", async () => {
    const { PLUGINS } = await importFresh();
    const ids = PLUGINS.map((p) => p.id);
    expect(ids).toEqual([
      "eslint",
      "ruff",
      "playwright",
      "typescript-language-server",
      "pyright",
      "fff",
    ]);
  });

  it("scopes linters + playwright as dev (-D), LSP servers as global (-g)", async () => {
    const { PLUGINS } = await importFresh();
    const byId = Object.fromEntries(PLUGINS.map((p) => [p.id, p]));
    expect(byId.eslint.installScope).toBe("dev");
    expect(byId.ruff.installScope).toBe("dev");
    expect(byId.playwright.installScope).toBe("dev");
    expect(byId["typescript-language-server"].installScope).toBe("global");
    expect(byId.pyright.installScope).toBe("global");
  });

  it("every plugin has a featureGate matching its feature's kill-switch", async () => {
    const { PLUGINS } = await importFresh();
    for (const p of PLUGINS) {
      expect(p.featureGate).toMatch(/^ZELARI_/);
      expect(typeof p.description).toBe("string");
      expect(p.description.length).toBeGreaterThan(0);
    }
  });
});

describe("isBinaryOnPath", () => {
  it("finds a bare binary on PATH (posix pathEnv + : separator)", async () => {
    const { isBinaryOnPath } = await importFresh();
    // Synthetic paths — never use a Windows drive path with platform:'linux'
    // (C:\... contains ':' and would split incorrectly under the posix sep).
    expect(
      isBinaryOnPath("pyright-langserver", {
        pathEnv: "/usr/local/bin:/opt/bin",
        platform: "linux",
        exists: (p) => p === "/opt/bin/pyright-langserver",
      }),
    ).toBe(true);
  });

  it("finds a .cmd shim on win32 via PATHEXT", async () => {
    const { isBinaryOnPath } = await importFresh();
    expect(
      isBinaryOnPath("pyright-langserver", {
        pathEnv: String.raw`C:\npm-global;C:\other`,
        pathExt: ".EXE;.CMD;.BAT",
        platform: "win32",
        exists: (p) => p === String.raw`C:\npm-global\pyright-langserver.cmd`,
      }),
    ).toBe(true);
  });

  it("returns false when missing (regression: pyright-langserver must NOT need --version)", async () => {
    const { isBinaryOnPath } = await importFresh();
    expect(
      isBinaryOnPath("pyright-langserver", {
        pathEnv: "/usr/bin:/bin",
        platform: "linux",
        exists: () => false,
      }),
    ).toBe(false);
  });

  it("rejects path-like names", async () => {
    const { isBinaryOnPath } = await importFresh();
    expect(isBinaryOnPath("/usr/bin/eslint", { platform: "linux" })).toBe(false);
    expect(isBinaryOnPath("..\\evil", { platform: "win32" })).toBe(false);
  });
});

describe("detectMissingPlugins", () => {
  it("returns all plugins when nothing is installed", async () => {
    applyScenario({
      localBins: {},
      playwrightPresent: false,
    });
    // Empty PATH so LSP globals look missing.
    process.env.PATH = path.join(tmpdir(), "no-bins-" + Date.now());
    const { detectMissingPlugins } = await importFresh();
    const missing = await detectMissingPlugins("/repo");
    expect(missing.map((p) => p.id).sort()).toEqual(
      ["eslint", "fff", "playwright", "pyright", "ruff", "typescript-language-server"],
    );
  });

  it("returns none when everything is installed", async () => {
    applyScenario({
      localBins: { eslint: "/repo/node_modules/.bin/eslint", ruff: "/repo/node_modules/.bin/ruff" },
      playwrightPresent: true,
    });
    const binDir = makePathBins([
      "typescript-language-server",
      "pyright-langserver",
      "fff-mcp",
    ]);
    try {
      process.env.PATH = binDir;
      process.env.PATHEXT = ".CMD;.EXE";
      const { detectMissingPlugins } = await importFresh();
      const missing = await detectMissingPlugins("/repo");
      expect(missing).toEqual([]);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("detects local binaries via resolveBin (eslint found, ruff missing)", async () => {
    applyScenario({
      localBins: { eslint: "/repo/node_modules/.bin/eslint" },
      playwrightPresent: false,
    });
    process.env.PATH = path.join(tmpdir(), "no-bins-" + Date.now());
    const { detectMissingPlugins } = await importFresh();
    const missing = await detectMissingPlugins("/repo");
    const ids = missing.map((p) => p.id);
    expect(ids).toContain("ruff");
    expect(ids).not.toContain("eslint");
  });

  it("detects LSP via PATH file presence, not --version (pyright-langserver case)", async () => {
    // The historical bug: pyright-langserver --version exits 1 with empty
    // stdout, so a version probe always said "missing". PATH existence must
    // be enough — same as runtime spawn.
    applyScenario({ localBins: {}, playwrightPresent: false });
    const binDir = makePathBins(["pyright-langserver"]);
    try {
      process.env.PATH = binDir;
      process.env.PATHEXT = ".CMD;.EXE";
      const { detectMissingPlugins } = await importFresh();
      const missing = await detectMissingPlugins("/repo");
      const ids = missing.map((p) => p.id);
      expect(ids).not.toContain("pyright");
      expect(ids).toContain("typescript-language-server"); // not on PATH in this scenario
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("detects project-local LSP bins via resolveBin before PATH", async () => {
    applyScenario({
      localBins: {
        "typescript-language-server": "/repo/node_modules/.bin/typescript-language-server",
        "pyright-langserver": "/repo/node_modules/.bin/pyright-langserver",
      },
      playwrightPresent: false,
    });
    process.env.PATH = path.join(tmpdir(), "no-bins-" + Date.now());
    const { detectMissingPlugins } = await importFresh();
    const missing = await detectMissingPlugins("/repo");
    const ids = missing.map((p) => p.id);
    expect(ids).not.toContain("typescript-language-server");
    expect(ids).not.toContain("pyright");
  });

  it("respects feature kill-switches (ZELARI_DIAGNOSTICS=0 hides eslint+ruff)", async () => {
    applyScenario({
      localBins: {},
      playwrightPresent: false,
    });
    process.env.PATH = path.join(tmpdir(), "no-bins-" + Date.now());
    process.env.ZELARI_DIAGNOSTICS = "0";
    const { detectMissingPlugins } = await importFresh();
    const missing = await detectMissingPlugins("/repo");
    const ids = missing.map((p) => p.id);
    expect(ids).not.toContain("eslint");
    expect(ids).not.toContain("ruff");
    expect(ids).toContain("playwright");
  });

  it("ZELARI_BROWSER=0 hides playwright", async () => {
    applyScenario({ localBins: {}, playwrightPresent: false });
    process.env.PATH = path.join(tmpdir(), "no-bins-" + Date.now());
    process.env.ZELARI_BROWSER = "0";
    const { detectMissingPlugins } = await importFresh();
    const missing = await detectMissingPlugins("/repo");
    expect(missing.map((p) => p.id)).not.toContain("playwright");
  });

  it("ZELARI_LSP=0 hides both LSP servers", async () => {
    applyScenario({ localBins: {}, playwrightPresent: false });
    process.env.PATH = path.join(tmpdir(), "no-bins-" + Date.now());
    process.env.ZELARI_LSP = "0";
    const { detectMissingPlugins } = await importFresh();
    const missing = await detectMissingPlugins("/repo");
    const ids = missing.map((p) => p.id);
    expect(ids).not.toContain("typescript-language-server");
    expect(ids).not.toContain("pyright");
  });
});

describe("findPlugin", () => {
  it("looks up a plugin by id", async () => {
    const { findPlugin } = await importFresh();
    expect(findPlugin("eslint")?.npmPackage).toBe("eslint");
    expect(findPlugin("nonexistent")).toBeUndefined();
  });
});

describe("playwright detect wiring", () => {
  it("does not report playwright missing when loadPlaywright succeeds for cwd", async () => {
    applyScenario({ playwrightPresent: true });
    process.env.PATH = path.join(tmpdir(), "no-bins-" + Date.now());
    const { detectMissingPlugins } = await importFresh();
    const missing = await detectMissingPlugins("/my/project");
    expect(missing.map((p) => p.id)).not.toContain("playwright");
  });
});
