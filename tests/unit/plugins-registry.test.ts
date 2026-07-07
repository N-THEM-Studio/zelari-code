/**
 * plugins-registry.test.ts — tests for the plugin catalog + detection.
 *
 * Covers the five plugins (eslint, ruff, playwright, typescript-language-server,
 * pyright) and the detectMissingPlugins aggregator. Detection mocks the
 * underlying primitives (resolveBin for local, spawnSync for global, the
 * playwright loader) so tests are deterministic and platform-independent.
 *
 * Mock pattern follows tests/unit/cli-prereqChecks.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---- Per-test scenario, read by the mocks. ----
type Scenario = {
  /** Simulated resolveBin result per binary. Bare name = "not found". */
  localBins?: Record<string, string>;
  /** Simulated spawnSync status per global binary. undefined = not probed. */
  globalBins?: Record<string, number>;
  /** Simulated playwright loader result. */
  playwrightPresent?: boolean;
};

let scenario: Scenario = {};

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn((cmd: string, args: string[]) => {
    // Global-bin probe: `<bin> --version`. cmd is the binary name.
    if (args[0] === "--version") {
      const status = scenario.globalBins?.[cmd];
      if (status === undefined) return { status: 127, stdout: "", stderr: "" };
      return { status, stdout: status === 0 ? "1.0.0\n" : "", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "" };
  }),
}));

// resolveBin is imported from diagnostics/engine.ts which uses existsSync.
// Mock node:fs so resolveBin's existsSync check returns per-scenario.
vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:fs");
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      // resolveBin looks for node_modules/.bin/<bin><suffix>. Check if any
      // scenario localBin was "found" (result !== bare name).
      const str = String(p);
      // Extract the bin name from the path: .../node_modules/.bin/<bin><suffix>
      const m = str.match(/[\\/]node_modules[\\/]\.bin[\\/](.+?)(\.cmd|\.exe)?$/);
      if (m) {
        const bin = m[1];
        const resolved = scenario.localBins?.[bin];
        // If the scenario says this bin is "found" (resolved !== bare name),
        // existsSync returns true.
        return resolved !== undefined && resolved !== bin;
      }
      return actual.existsSync(p);
    }),
  };
});

// Mock the playwright loader so detectPlaywright doesn't do a real import.
vi.mock("../../src/cli/browser/driver.js", () => ({
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

beforeEach(() => {
  scenario = {};
  vi.clearAllMocks();
  applyScenario({});
});

afterEach(() => {
  process.env = { ...REAL_ENV };
});

describe("PLUGINS catalog", () => {
  it("has the 5 expected plugins with stable ids", async () => {
    const { PLUGINS } = await importFresh();
    const ids = PLUGINS.map((p) => p.id);
    expect(ids).toEqual([
      "eslint",
      "ruff",
      "playwright",
      "typescript-language-server",
      "pyright",
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

describe("detectMissingPlugins", () => {
  it("returns all 5 when nothing is installed", async () => {
    applyScenario({
      localBins: {}, // eslint/ruff not found
      globalBins: {}, // ts-lsp/pyright not found
      playwrightPresent: false,
    });
    const { detectMissingPlugins } = await importFresh();
    const missing = await detectMissingPlugins("/repo");
    expect(missing.map((p) => p.id).sort()).toEqual(
      ["eslint", "playwright", "pyright", "ruff", "typescript-language-server"],
    );
  });

  it("returns none when everything is installed", async () => {
    applyScenario({
      localBins: { eslint: "/repo/node_modules/.bin/eslint", ruff: "/repo/node_modules/.bin/ruff" },
      globalBins: { "typescript-language-server": 0, "pyright-langserver": 0 },
      playwrightPresent: true,
    });
    const { detectMissingPlugins } = await importFresh();
    const missing = await detectMissingPlugins("/repo");
    expect(missing).toEqual([]);
  });

  it("detects local binaries via resolveBin (eslint found, ruff missing)", async () => {
    applyScenario({
      localBins: { eslint: "/repo/node_modules/.bin/eslint" }, // ruff absent
      globalBins: {},
      playwrightPresent: false,
    });
    const { detectMissingPlugins } = await importFresh();
    const missing = await detectMissingPlugins("/repo");
    const ids = missing.map((p) => p.id);
    expect(ids).toContain("ruff");
    expect(ids).not.toContain("eslint");
  });

  it("respects feature kill-switches (ZELARI_DIAGNOSTICS=0 hides eslint+ruff)", async () => {
    applyScenario({
      localBins: {},
      globalBins: {},
      playwrightPresent: false,
    });
    process.env.ZELARI_DIAGNOSTICS = "0";
    const { detectMissingPlugins } = await importFresh();
    const missing = await detectMissingPlugins("/repo");
    const ids = missing.map((p) => p.id);
    expect(ids).not.toContain("eslint");
    expect(ids).not.toContain("ruff");
    // playwright + LSP are unaffected by ZELARI_DIAGNOSTICS
    expect(ids).toContain("playwright");
  });

  it("ZELARI_BROWSER=0 hides playwright", async () => {
    applyScenario({ localBins: {}, globalBins: {}, playwrightPresent: false });
    process.env.ZELARI_BROWSER = "0";
    const { detectMissingPlugins } = await importFresh();
    const missing = await detectMissingPlugins("/repo");
    expect(missing.map((p) => p.id)).not.toContain("playwright");
  });

  it("ZELARI_LSP=0 hides both LSP servers", async () => {
    applyScenario({ localBins: {}, globalBins: {}, playwrightPresent: false });
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
