/**
 * plugins-prefs.test.ts — tests for the plugin preferences file.
 *
 * Validates read/write/corrupt-fallback semantics. Each test isolates the
 * prefs file via ZELARI_PLUGINS_PREFS_FILE pointing at a tmp path, so no
 * test pollutes the user's real ~/.tmp/zelari-code/plugins.json.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "zelari-prefs-"));
const PREFS_FILE = path.join(TMP, "plugins.json");

function importFresh() {
  vi.resetModules();
  // Re-set env after resetModules (module captures env at load for path).
  process.env.ZELARI_PLUGINS_PREFS_FILE = PREFS_FILE;
  return import("../../src/cli/plugins/prefs.js");
}

beforeEach(() => {
  process.env.ZELARI_PLUGINS_PREFS_FILE = PREFS_FILE;
  if (existsSync(PREFS_FILE)) rmSync(PREFS_FILE, { force: true });
});

afterEach(() => {
  if (existsSync(PREFS_FILE)) rmSync(PREFS_FILE, { force: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("getPluginPrefs", () => {
  it("returns defaults when the file is missing", async () => {
    const { getPluginPrefs } = await importFresh();
    const prefs = getPluginPrefs();
    expect(prefs.version).toBe(1);
    expect(prefs.dontAskAgain).toEqual({});
  });

  it("reads a valid file", async () => {
    writeFileSync(PREFS_FILE, JSON.stringify({ version: 1, dontAskAgain: { eslint: true } }));
    const { getPluginPrefs } = await importFresh();
    const prefs = getPluginPrefs();
    expect(prefs.dontAskAgain).toEqual({ eslint: true });
  });

  it("falls back to defaults on corrupt JSON", async () => {
    writeFileSync(PREFS_FILE, "{ not valid json ;;");
    const { getPluginPrefs } = await importFresh();
    const prefs = getPluginPrefs();
    expect(prefs.dontAskAgain).toEqual({});
  });

  it("drops non-boolean junk entries during read", async () => {
    writeFileSync(PREFS_FILE, JSON.stringify({
      version: 1,
      dontAskAgain: { eslint: true, ruff: "yes", playwright: false, "": true },
    }));
    const { getPluginPrefs } = await importFresh();
    const prefs = getPluginPrefs();
    // Only eslint (true) survives; ruff (string), playwright (false), "" dropped.
    expect(prefs.dontAskAgain).toEqual({ eslint: true });
  });
});

describe("markDontAskAgain / isMuted", () => {
  it("marks a plugin muted and persists it", async () => {
    const { markDontAskAgain, isMuted } = await importFresh();
    expect(isMuted("eslint")).toBe(false);
    markDontAskAgain("eslint");
    expect(isMuted("eslint")).toBe(true);
    // File now exists on disk.
    expect(existsSync(PREFS_FILE)).toBe(true);
    const raw = JSON.parse(readFileSync(PREFS_FILE, "utf-8"));
    expect(raw.dontAskAgain.eslint).toBe(true);
  });

  it("is idempotent (marking twice doesn't duplicate)", async () => {
    const { markDontAskAgain, getPluginPrefs } = await importFresh();
    markDontAskAgain("eslint");
    markDontAskAgain("eslint");
    const prefs = getPluginPrefs();
    expect(Object.keys(prefs.dontAskAgain)).toEqual(["eslint"]);
  });

  it("clearDontAskAgain removes the flag", async () => {
    const { markDontAskAgain, clearDontAskAgain, isMuted } = await importFresh();
    markDontAskAgain("ruff");
    expect(isMuted("ruff")).toBe(true);
    clearDontAskAgain("ruff");
    expect(isMuted("ruff")).toBe(false);
  });
});

describe("write safety", () => {
  it("writes with mode 0o600 (owner-only) on POSIX", async () => {
    // Windows (win32) does not honor POSIX permission bits — writeFileSync
    // mode is ignored and stat reports 0o666. Skip the assertion there.
    if (process.platform === "win32") return;
    const { markDontAskAgain } = await importFresh();
    markDontAskAgain("eslint");
    const stat = await import("node:fs/promises").then((m) => m.stat(PREFS_FILE));
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
