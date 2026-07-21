/**
 * core-toolResultTruncation.test.ts — tests for truncateToolResult (H6 / v1.21 spill).
 *
 * Verifies the head+tail truncation that keeps tool-result messages bounded
 * in the LLM transcript. A 5000-line read_file used to dump ~100k tokens
 * into config.messages; now results over the cap (default 200 lines) are
 * truncated with a marker naming the omission, and optionally spilled to disk.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncateToolResult } from "@zelari/core/harness/tools/registry";

describe("truncateToolResult", () => {
  const realEnv = { ...process.env };
  let spillDir: string;

  beforeEach(() => {
    process.env = { ...realEnv };
    spillDir = mkdtempSync(join(tmpdir(), "zelari-spill-"));
    process.env.ZELARI_TOOL_OUTPUT_DIR = spillDir;
    process.env.ZELARI_TOOL_SPILL = "1";
  });

  afterEach(() => {
    process.env = { ...realEnv };
    try {
      rmSync(spillDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("passes short results through verbatim (under line cap)", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    expect(truncateToolResult(text, 200)).toBe(text);
  });

  it("passes single-line results through verbatim (under char budget)", () => {
    const text = "a short single-line result";
    expect(truncateToolResult(text, 200)).toBe(text);
  });

  it("truncates a 5000-line result to head + tail + marker", () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    const text = lines.join("\n");
    const out = truncateToolResult(text, { cap: 200, spill: false });
    // Marker present, names the omission count and the head/tail split.
    // omitted = total - cap = 5000 - 200 = 4800.
    expect(out).toMatch(/\[\+4800 lines omitted.*head:100.*tail:100.*of 5000 total\]/);
    // Head retained: first line preserved.
    expect(out).toContain("line 0");
    expect(out).toContain("line 99");
    // Tail retained: last line preserved.
    expect(out).toContain("line 4999");
    expect(out).toContain("line 4900");
    // Middle omitted.
    expect(out).not.toContain("line 2500");
  });

  it("spills full text to managed dir when truncated", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    const text = lines.join("\n");
    const out = truncateToolResult(text, { cap: 50, toolName: "read_file" });
    expect(out).toMatch(/full output spilled to:/);
    const m = out.match(/full output spilled to: ([^\s…]+)/);
    expect(m?.[1]).toBeTruthy();
    const path = m![1];
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("does not spill when spill:false", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    const out = truncateToolResult(lines.join("\n"), { cap: 50, spill: false });
    expect(out).not.toMatch(/spilled to/);
  });

  it("respects a custom cap (50 lines)", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const out = truncateToolResult(lines.join("\n"), { cap: 50, spill: false });
    // omitted = 200 - 50 = 150; head/tail = 25 each.
    expect(out).toMatch(/\[\+150 lines omitted.*head:25.*tail:25.*of 200 total\]/);
    expect(out).toContain("line 0");
    expect(out).toContain("line 199");
    expect(out).not.toContain("line 100");
  });

  it("does not truncate an error-sized string (errors pass verbatim)", () => {
    const errText = "Error: tool failed with code 42";
    expect(truncateToolResult(errText, 200)).toBe(errText);
  });

  it("handles empty string", () => {
    expect(truncateToolResult("", 200)).toBe("");
  });

  it("truncates huge single-line payloads by char budget", () => {
    // char budget = 200 * 80 = 16000; 30000 chars single line exceeds it.
    const longLine = "x".repeat(30000);
    const out = truncateToolResult(longLine, { cap: 200, spill: false });
    expect(out).not.toBe(longLine);
    expect(out).toMatch(/chars omitted/);
    expect(out.length).toBeLessThan(longLine.length);
  });

  it("truncates when many short lines exceed the line cap", () => {
    // 300 short lines (each 5 chars): char budget 300*6=1800 < 16000, so the
    // fast path does NOT fire. The line-budget check fires: 300 > 200.
    const lines = Array.from({ length: 300 }, () => "short");
    const out = truncateToolResult(lines.join("\n"), { cap: 200, spill: false });
    expect(out).toMatch(/\[\+100 lines omitted/);
  });
});
