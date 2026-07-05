import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyInlineJsAutofix } from "../../packages/core/src/council/verification/inlineJsAutofix.js";
import { runImplementationVerification } from "../../packages/core/src/council/verification/runChecks.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "zelari-inline-js-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("applyInlineJsAutofix", () => {
  it("trims comments and optional blocks to satisfy inline-js budget", () => {
    const pad = "x".repeat(6000);
    const bigJs = [
      "/* verbose header */",
      "(() => {",
      "  'use strict';",
      "  // comment",
      `  const pad = "${pad}";`,
      "  if (!reduceMotion) {",
      "    const tiltEls = document.querySelectorAll('.card');",
      "    tiltEls.forEach(el => { el.addEventListener('mousemove', () => {}); });",
      "  }",
      "})();",
    ].join("\n");
    const html = `<!DOCTYPE html><html><body><script>${bigJs}</script></body></html>`;
    writeFileSync(join(tmpDir, "index.html"), html, "utf8");
    const before = runImplementationVerification({
      projectRoot: tmpDir,
      zelariRoot: join(tmpDir, ".zelari"),
    });
    expect(
      before.results.some((r) => r.id === "inline-js.budget" && !r.ok),
    ).toBe(true);
    const fix = applyInlineJsAutofix(tmpDir, before);
    expect(fix.applied).toBe(true);
    const after = runImplementationVerification({
      projectRoot: tmpDir,
      zelariRoot: join(tmpDir, ".zelari"),
    });
    expect(
      after.results.some((r) => r.id === "inline-js.budget" && !r.ok),
    ).toBe(false);
    const saved = readFileSync(join(tmpDir, "index.html"), "utf8");
    expect(saved).not.toContain("verbose header");
  });
});
