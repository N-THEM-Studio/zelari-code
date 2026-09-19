/**
 * cli-toolVerbose.test.ts — v2.51 ctrl+O verbose tool output (mcode steal).
 *
 * Coverage:
 *  1. formatToolResult({verbose}) disables the display line cap (fallback
 *     plain-text branch and the bash envelope branch).
 *  2. toolResultForStorage keeps the UNTRUNCATED body (line-wise) so the
 *     render-time toggle has something to reveal — the 8000-char bound
 *     still applies.
 *  3. renderMessage(m, live, verbose) plumbs the flag into <ToolOutput>.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  formatToolResult,
  toolResultForStorage,
} from "../../src/cli/components/toolFormat.js";

// The default cap is 8 lines; make sure the ambient env cannot skew counts.
beforeEach(() => {
  delete process.env.ZELARI_TOOL_OUTPUT_LINES;
});

function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line-${i + 1}`).join("\n");
}

describe("formatToolResult — verbose option (ctrl+O)", () => {
  it("default truncates a long plain-text body to the cap with a +K marker", () => {
    const out = formatToolResult("grep", lines(20));
    expect(out.lines).toHaveLength(9); // 8 lines + marker
    expect(out.lines[8]).toBe("… (+12 lines)");
  });

  it("verbose returns every line with no truncation marker", () => {
    const out = formatToolResult("grep", lines(20), { verbose: true });
    expect(out.lines).toHaveLength(20);
    expect(out.lines.join("\n")).not.toContain("(+");
    expect(out.lines[19]).toBe("line-20");
  });

  it("bash envelope: default 8 + marker, verbose keeps stdout + meta intact", () => {
    const env = JSON.stringify({ stdout: lines(12), stderr: "boom", exitCode: 1 });
    const compact = formatToolResult("bash", env);
    expect(compact.lines).toHaveLength(9);
    expect(compact.lines[8]).toBe("… (+4 lines)");
    expect(compact.meta).toBe("stderr: boom · exit 1");

    const full = formatToolResult("bash", env, { verbose: true });
    expect(full.lines).toHaveLength(12);
    expect(full.lines[11]).toBe("line-12");
    expect(full.meta).toBe("stderr: boom · exit 1");
  });

  it("short bodies are unchanged in verbose mode (no behavior regression)", () => {
    const short = formatToolResult("grep", lines(3), { verbose: true });
    expect(short.lines).toEqual(["line-1", "line-2", "line-3"]);
  });
});

describe("toolResultForStorage — stores the untruncated body", () => {
  it("keeps line 12 of a 12-line bash stdout (no +K marker), char-bound intact", () => {
    const stored = toolResultForStorage(
      "bash",
      JSON.stringify({ stdout: lines(12), exitCode: 0 }),
      false,
    );
    expect(stored).toContain("line-12");
    expect(stored).not.toContain("(+");
    expect(stored.length).toBeLessThanOrEqual(8000);
  });
});

describe("renderMessage — verbose plumbing into <ToolOutput>", () => {
  it("passes verbose=false by default and verbose=true when asked", async () => {
    const React = (await import("react")).default;
    const { renderMessage } = await import(
      "../../src/cli/components/ChatStream.js"
    );
    const { ToolOutput } = await import(
      "../../src/cli/components/ToolOutput.js"
    );
    const m = {
      id: "t1",
      role: "tool" as const,
      content: "ls src",
      ts: Date.now(),
      toolName: "bash",
      toolResult: lines(20),
      toolOk: true,
      toolDurationMs: 5,
    };
    const el = renderMessage(m, false) as React.ReactElement;
    expect(el.type).toBe(ToolOutput);
    expect(el.props.verbose).toBe(false);

    const elVerbose = renderMessage(m, false, true) as React.ReactElement;
    expect(elVerbose.props.verbose).toBe(true);
  });
});
