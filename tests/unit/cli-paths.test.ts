/**
 * cli-paths.test.ts — tests for relativePosix() in src/cli/utils/paths.ts.
 *
 * relativePosix exists to kill the win32 backslash-in-output bug: LSP tool
 * results and diagnostic output were emitting `src\a.ts` where every other
 * path in the agent stream uses `src/a.ts`. It wraps path.relative() and
 * normalizes separators to forward slashes, plus the "fall back to absolute
 * if it escapes the root" guard shared with the old private helpers.
 *
 * Cross-platform testing: path.relative() behaviour depends on process.platform
 * (win32 vs posix). We override process.platform per-test to exercise both
 * branches without needing to run on two OSes. Pattern follows
 * tests/unit/cli-prereqChecks.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const REAL_PLATFORM = process.platform;

async function importFresh() {
  vi.resetModules();
  return (await import("../../src/cli/utils/paths.js")) as typeof import("../../src/cli/utils/paths.js");
}

function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
});

describe("relativePosix — relativization + separator normalization", () => {
  it("relativizes a nested file against its root on POSIX", async () => {
    setPlatform("linux");
    const { relativePosix } = await importFresh();
    expect(relativePosix("/repo", "/repo/src/a.ts")).toBe("src/a.ts");
  });

  it("normalizes win32 backslashes to forward slashes (THE bug fix)", async () => {
    // On win32, path.relative('C:\\repo', 'C:\\repo\\src\\a.ts') returns
    // 'src\\a.ts'. relativePosix must convert that to 'src/a.ts'.
    setPlatform("win32");
    const { relativePosix } = await importFresh();
    expect(relativePosix("C:\\repo", "C:\\repo\\src\\a.ts")).toBe("src/a.ts");
  });

  it("handles nested directories, not just files", async () => {
    setPlatform("win32");
    const { relativePosix } = await importFresh();
    expect(relativePosix("C:\\repo", "C:\\repo\\src\\nested\\deep.ts")).toBe(
      "src/nested/deep.ts",
    );
  });

  it("returns the absolute target unchanged when it escapes the root (..)", async () => {
    // Don't relativize paths outside the project — showing '..\\..\\elsewhere'
    // would mislead the user. Pass through the original absolute path.
    setPlatform("linux");
    const { relativePosix } = await importFresh();
    expect(relativePosix("/repo", "/elsewhere/file.ts")).toBe("/elsewhere/file.ts");
  });

  it("returns the target unchanged when relativization yields empty", async () => {
    // `to === from` case: path.relative returns ''. We must not return ''
    // (which would be a useless display string).
    setPlatform("linux");
    const { relativePosix } = await importFresh();
    expect(relativePosix("/repo", "/repo")).toBe("/repo");
  });

  it("passes through already-POSIX input on win32 without double-conversion", async () => {
    // Mixed input (forward-slash absolute path on win32): path.relative may
    // still resolve it; the key invariant is the OUTPUT has no backslashes.
    setPlatform("win32");
    const { relativePosix } = await importFresh();
    const result = relativePosix("C:/repo", "C:/repo/src/a.ts");
    expect(result).not.toContain("\\");
  });

  it("never throws — returns the target on any path.relative failure", async () => {
    // Garbage input shouldn't crash. path.relative may throw on some null-ish
    // args on certain node versions; relativePosix must swallow and pass through.
    setPlatform("linux");
    const { relativePosix } = await importFresh();
    const weird = "\u0000weird";
    const result = relativePosix("/repo", weird);
    expect(typeof result).toBe("string");
  });
});
