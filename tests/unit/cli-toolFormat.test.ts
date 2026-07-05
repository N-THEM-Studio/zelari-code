/**
 * cli-toolFormat.test.ts — v0.7.1 pure-function tests for the tool formatters
 * (plan B1+B2).
 *
 * Pins the contracts that kill the v0.7.0 rendering problems:
 *   - raw JSON envelopes with escaped `\n` → real stdout lines for bash
 *   - raw-JSON args summary → human-readable per-tool summary
 *   - 600-char mid-string cut → line-based truncation with `… (+K lines)`
 *   - write_file/edit_file success → one-line inline result (no box)
 *   - read_file/grep_content success → one-line operation + paths (no body)
 */
import { describe, it, expect } from "vitest";
import {
  formatToolResult,
  formatToolSummary,
  toolResultForStorage,
  TOOL_RESULT_PREVIEW_CHARS,
} from "../../src/cli/components/toolFormat.js";

describe("formatToolResult (B1) — per-tool body formatting", () => {
  it("bash: extracts real stdout lines (no escaped \\n), appends stderr + exit when present", () => {
    const result = JSON.stringify({
      stdout: "line1\nline2\nline3",
      stderr: "",
      exitCode: 0,
    });
    const out = formatToolResult("bash", result);
    expect(out.lines).toEqual(["line1", "line2", "line3"]);
    expect(out.meta).toBeUndefined();
    expect(out.oneLine).not.toBe(true);
  });

  it("bash: surfaces non-zero exit + stderr in meta", () => {
    const result = JSON.stringify({
      stdout: "ok",
      stderr: "oops",
      exitCode: 2,
    });
    const out = formatToolResult("bash", result);
    expect(out.lines).toEqual(["ok"]);
    expect(out.meta).toMatch(/stderr: oops/);
    expect(out.meta).toMatch(/exit 2/);
  });

  it("read_file: one-line summary with path and line count (no body)", () => {
    const pathMod = require("node:path");
    const abs = pathMod.join(process.cwd(), "src", "b.txt");
    const result = JSON.stringify({
      path: abs,
      content: "alpha\nbeta",
      totalLines: 42,
      readLines: { start: 0, end: 1 },
      sizeBytes: 10,
    });
    const out = formatToolResult("read_file", result);
    expect(out.oneLine).toBe(true);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toMatch(/^read — /);
    expect(out.lines[0]).toContain("b.txt");
    expect(out.lines[0]).toMatch(/of 42/);
    expect(out.lines[0]).not.toContain("alpha");
  });

  it("write_file: success is a single one-line result (no box)", () => {
    const path = require("node:path");
    const abs = path.join(process.cwd(), "foo.txt");
    const result = JSON.stringify({ path: abs, bytesWritten: 106496 });
    const out = formatToolResult("write_file", result);
    expect(out.oneLine).toBe(true);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toMatch(/wrote .+ → /);
    // Path is made relative to cwd when possible.
    expect(out.lines[0]).toContain("foo.txt");
  });

  it("edit_file: success reports occurrences replaced, one-line", () => {
    const path = require("node:path");
    const abs = path.join(process.cwd(), "bar.ts");
    const result = JSON.stringify({ path: abs, occurrencesReplaced: 3 });
    const out = formatToolResult("edit_file", result);
    expect(out.oneLine).toBe(true);
    expect(out.lines[0]).toMatch(/replaced 3 occurrence/);
  });

  it("list_files: entry count + dir only (one-line, no names)", () => {
    const path = require("node:path");
    const dir = path.join(process.cwd());
    const result = JSON.stringify({
      dir,
      entries: [
        { name: "a.ts", type: "file" },
        { name: "b.ts", type: "file" },
      ],
      truncated: false,
    });
    const out = formatToolResult("list_files", result);
    expect(out.oneLine).toBe(true);
    expect(out.lines[0]).toMatch(/^list — 2 entries/);
    expect(out.lines[0]).not.toContain("a.ts");
  });

  it("truncates by LINES with a … (+K lines) tail, not mid-string", () => {
    const many = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    const result = JSON.stringify({ stdout: many, stderr: "", exitCode: 0 });
    const out = formatToolResult("bash", result);
    // Default cap is 8 lines → 8 kept + 1 marker.
    expect(out.lines.length).toBe(9);
    expect(out.lines[out.lines.length - 1]).toMatch(/\(\+22 lines\)/);
    // No mid-string split of a JSON value.
    expect(out.lines.some((l) => l.includes('"'))).toBe(false);
  });

  it("falls back to plain text for unparseable / unknown tool results", () => {
    const out = formatToolResult(
      "unknown_tool",
      "just a plain string\nsecond line",
    );
    expect(out.lines).toEqual(["just a plain string", "second line"]);
  });

  it("grep_content: file count only when multiple files hit (no match text)", () => {
    const pathMod = require("node:path");
    const root = pathMod.join(process.cwd(), "src");
    const result = JSON.stringify({
      matches: [
        {
          file: pathMod.join(root, "a.ts"),
          relPath: "a.ts",
          line: 1,
          text: "foo",
        },
        {
          file: pathMod.join(root, "b.ts"),
          relPath: "b.ts",
          line: 4,
          text: "foo",
        },
      ],
      totalMatches: 2,
      filesSearched: 2,
    });
    const out = formatToolResult("grep_content", result);
    expect(out.oneLine).toBe(true);
    expect(out.lines).toEqual(["grep — 2 files"]);
    expect(out.lines[0]).not.toContain("foo");
  });

  it("grep_content: single file name when one file hit", () => {
    const pathMod = require("node:path");
    const abs = pathMod.join(process.cwd(), "index.html");
    const result = JSON.stringify({
      matches: [
        { file: abs, relPath: "index.html", line: 10, text: "box-shadow" },
      ],
      totalMatches: 1,
      filesSearched: 1,
    });
    const out = formatToolResult("grep_content", result);
    expect(out.lines).toEqual(["grep — index.html"]);
  });

  it("searchDocuments: file count only (no snippets)", () => {
    const body = [
      "[docs/plan.md]",
      "…milestone phase one…",
      "",
      "[docs/risks.md]",
      "…command palette risk…",
    ].join("\n");
    const out = formatToolResult("searchDocuments", body);
    expect(out.oneLine).toBe(true);
    expect(out.lines).toEqual(["search — 2 files"]);
    expect(out.lines[0]).not.toContain("milestone");
  });

  it("searchDocuments: single file name when one hit", () => {
    const body = "[plan-tasks/foo.md]\n…some snippet text…";
    const out = formatToolResult("searchDocuments", body);
    expect(out.lines).toEqual(["search — plan-tasks/foo.md"]);
  });
});

describe("formatToolSummary (B2) — per-tool summary line", () => {
  it("bash: the command string", () => {
    expect(formatToolSummary("bash", { command: "npm test" })).toBe("npm test");
  });

  it("read_file: path relative to cwd when under cwd", () => {
    // Use a path joined from process.cwd() so it is genuinely relative on
    // every platform (the tools build paths via path.join(cwd, ...) too).
    const path = require("node:path");
    const abs = path.join(process.cwd(), "package.json");
    const s = formatToolSummary("read_file", { path: abs });
    expect(s).toBe("package.json");
  });

  it("write_file: the path", () => {
    const path = require("node:path");
    const abs = path.join(process.cwd(), "src", "x.ts");
    const s = formatToolSummary("write_file", { path: abs });
    expect(s).toContain("x.ts");
  });

  it("list_files: dir + depth", () => {
    const path = require("node:path");
    const abs = path.join(process.cwd(), "src");
    const s = formatToolSummary("list_files", { dir: abs, maxDepth: 2 });
    expect(s).toContain("src");
    expect(s).toMatch(/depth 2/);
  });

  it("grep_content: pattern + path", () => {
    const path = require("node:path");
    const abs = path.join(process.cwd(), "src");
    const s = formatToolSummary("grep_content", { pattern: "TODO", path: abs });
    expect(s).toMatch(/^TODO/);
    expect(s).toContain("src");
  });

  it("truncates at maxWidth with a single trailing … (no mid-token JSON cut)", () => {
    const long = { command: "x".repeat(200) };
    const s = formatToolSummary("bash", long, 40);
    expect(s.length).toBe(40);
    expect(s.endsWith("…")).toBe(true);
  });

  it("falls back to compact JSON for unknown tools, capped at width", () => {
    const s = formatToolSummary("mystery_tool", { a: 1, b: 2 }, 50);
    expect(s.length).toBeLessThanOrEqual(50);
    expect(s.startsWith("{")).toBe(true);
  });
});

describe("toolResultForStorage — format before truncate", () => {
  it("large read_file JSON becomes a compact one-liner (not raw envelope)", () => {
    const pathMod = require("node:path");
    const abs = pathMod.join(process.cwd(), "index.html");
    const hugeBody = "x".repeat(TOOL_RESULT_PREVIEW_CHARS + 500);
    const result = JSON.stringify({
      path: abs,
      content: hugeBody,
      totalLines: 900,
      readLines: { start: 0, end: 899 },
      sizeBytes: hugeBody.length,
    });
    const stored = toolResultForStorage("read_file", result, false);
    expect(stored).toMatch(/^read — /);
    expect(stored).toContain("index.html");
    expect(stored).not.toContain(hugeBody);
    expect(stored.length).toBeLessThan(200);
  });

  it("truncates formatted bash stdout after formatting", () => {
    const longLine = "x".repeat(800);
    const result = JSON.stringify({
      stdout: longLine,
      stderr: "",
      exitCode: 0,
    });
    const stored = toolResultForStorage("bash", result, false, 500);
    expect(stored.length).toBe(501);
    expect(stored.endsWith("…")).toBe(true);
    expect(stored.startsWith("xxx")).toBe(true);
  });

  it("round-trips already-formatted compact grep results", () => {
    const stored = toolResultForStorage(
      "grep_content",
      "grep — 3 files",
      false,
    );
    expect(stored).toBe("grep — 3 files");
  });
});
