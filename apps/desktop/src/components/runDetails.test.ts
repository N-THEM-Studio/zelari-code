/**
 * runDetails (F4 polish of the global runs dashboard) — contract under test:
 *   - the project chip is the basename of the run cwd, and the LABELED
 *     fallback ("app") when nothing is bound — never an invented folder;
 *   - the excerpt is the user prompt that STARTED the run (the last one at or
 *     before `startedAt`), collapsed to one line and capped at 120 chars;
 *   - a conversation without an eligible prompt keeps the honest "—";
 *   - the relative column is "2 min fa" via Intl.RelativeTimeFormat and falls
 *     back to the absolute HH:mm when the runtime has no formatter.
 *
 * No jsdom here on purpose: this module is pure (no React, no Tauri, no clock)
 * — same shape as tentacleVerdict.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  formatClock,
  formatRelativeTime,
  projectLabel,
  PROMPT_EXCERPT_MAX,
  PROMPT_FALLBACK,
  promptExcerpt,
  PROJECT_FALLBACK,
  runCwd,
} from "./runDetails";
import type { ChatMessage, Conversation } from "../types";
import type { RunRuntime } from "../runs/types";

const T0 = 1_700_000_000_000;

function msg(
  id: string,
  role: ChatMessage["role"],
  content: string,
  createdAt: number,
): ChatMessage {
  return { id, role, content, createdAt };
}

function conv(over: Partial<Conversation> & { id: string }): Conversation {
  return {
    title: `chat-${over.id}`,
    messages: [],
    createdAt: T0,
    updatedAt: T0,
    mode: "kraken",
    phase: "build",
    ...over,
  };
}

function run(over: Partial<RunRuntime> & { runId: string; conversationId: string }): RunRuntime {
  return { status: "running", startedAt: T0, ...over };
}

describe("projectLabel / runCwd", () => {
  it("takes the last path segment of either separator style", () => {
    expect(projectLabel("Z:\\EasyPeasy\\zelari-code")).toBe("zelari-code");
    expect(projectLabel("/home/me/apps/my_app/")).toBe("my_app");
    expect(projectLabel("my-app")).toBe("my-app");
  });

  it("falls back to the labeled chip when no cwd is bound", () => {
    expect(projectLabel(undefined)).toBe(PROJECT_FALLBACK);
    expect(projectLabel("")).toBe(PROJECT_FALLBACK);
    expect(projectLabel("   ")).toBe(PROJECT_FALLBACK);
    expect(PROJECT_FALLBACK).toBe("app");
  });

  it("prefers the cwd the run itself reported, then the chat binding", () => {
    const chat = conv({ id: "c1", cwd: "Z:\\work\\chat-folder" });
    expect(runCwd(run({ runId: "r1", conversationId: "c1", cwd: " Z:\\work\\run-folder " }), chat)).toBe(
      "Z:\\work\\run-folder",
    );
    expect(runCwd(run({ runId: "r2", conversationId: "c1" }), chat)).toBe("Z:\\work\\chat-folder");
    expect(runCwd(run({ runId: "r3", conversationId: "gone" }), undefined)).toBe("");
  });
});

describe("promptExcerpt", () => {
  it("quotes the last user prompt sent at or before the run started", () => {
    const messages = [
      msg("m1", "user", "the OLD prompt of the chat", T0 - 60_000),
      msg("m2", "assistant", "sure", T0 - 50_000),
      msg("m3", "user", "the prompt of THIS run", T0 - 6_000),
      msg("m4", "user", "sent AFTER the run started", T0 + 5_000),
    ];
    expect(promptExcerpt(messages, T0 - 5_000)).toBe("the prompt of THIS run");
  });

  it("collapses whitespace to one line and truncates at 120 chars", () => {
    const long = `  first   line\nsecond line ${"x".repeat(200)}`;
    const excerpt = promptExcerpt([msg("m1", "user", long, T0)], T0);
    expect(excerpt.startsWith("first line second line ")).toBe(true);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt.length).toBe(PROMPT_EXCERPT_MAX + 1);
    // Short prompts are handed through untouched.
    expect(promptExcerpt([msg("m1", "user", "  hi\nthere  ", T0)], T0)).toBe("hi there");
  });

  it("falls back to the first prompt, then to the honest placeholder", () => {
    // No timestamp at or before the start (replayed history): first prompt wins.
    const late = [msg("m1", "user", "first", T0 + 1_000), msg("m2", "user", "second", T0 + 2_000)];
    expect(promptExcerpt(late, T0)).toBe("first");
    expect(promptExcerpt(undefined, T0)).toBe(PROMPT_FALLBACK);
    expect(promptExcerpt([], T0)).toBe(PROMPT_FALLBACK);
    expect(promptExcerpt([msg("m1", "assistant", "no user here", T0)], T0)).toBe(PROMPT_FALLBACK);
    expect(promptExcerpt([msg("m1", "user", "   \n  ", T0)], T0)).toBe(PROMPT_FALLBACK);
    expect(PROMPT_FALLBACK).toBe("—");
  });
});

describe("formatRelativeTime / formatClock", () => {
  it("names recent starts in Italian and the clock time of older ones", () => {
    expect(formatRelativeTime(T0 - 120_000, T0)).toBe("2 min fa");
    expect(formatRelativeTime(T0 - 5_000, T0)).toBe("ora");
    expect(formatRelativeTime(T0 - 3 * 3_600_000, T0)).toBe("3 h fa");
    // Past a week the relative form stops being useful.
    expect(formatRelativeTime(T0 - 40 * 24 * 3_600_000, T0)).toBe(formatClock(T0 - 40 * 24 * 3_600_000));
    expect(formatClock(T0)).toMatch(/^\d{2}:\d{2}$/);
  });

  it("uses the absolute clock for a start in the future or an unusable stamp", () => {
    expect(formatRelativeTime(T0 + 60_000, T0)).toBe(formatClock(T0 + 60_000));
    expect(formatClock(Number.NaN)).toBe("—");
  });

  it("degrades to HH:mm on a runtime without Intl.RelativeTimeFormat", () => {
    // The TS lib marks the namespace member readonly; the runtime property is
    // writable, so a narrow cast lets this test simulate the degraded runtime.
    const intl = Intl as unknown as { RelativeTimeFormat?: typeof Intl.RelativeTimeFormat };
    const real = intl.RelativeTimeFormat;
    intl.RelativeTimeFormat = undefined;
    try {
      expect(formatRelativeTime(T0 - 60_000, T0)).toBe(formatClock(T0 - 60_000));
    } finally {
      intl.RelativeTimeFormat = real;
    }
    expect(formatRelativeTime(T0 - 60_000, T0)).toBe("1 min fa");
  });
});
