/**
 * Desktop session export (Markdown transcript) + filename slug helpers.
 * Tests live under monorepo tests/ and import via relative path.
 */
import { describe, it, expect } from "vitest";
import {
  conversationToMarkdown,
  exportFileName,
  hasExportableMessages,
  slugifyTitle,
} from "../../apps/desktop/src/exportSession";
import type { ChatMessage, Conversation } from "../../apps/desktop/src/types";

function msg(partial: Partial<ChatMessage> & { role: ChatMessage["role"] }): ChatMessage {
  return {
    id: `m-${Math.random().toString(36).slice(2, 8)}`,
    content: "",
    createdAt: 1_700_000_000_000,
    ...partial,
  };
}

function conv(messages: ChatMessage[], partial: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-1",
    title: "My session",
    messages,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_300_000,
    mode: "kraken",
    phase: "build",
    ...partial,
  };
}

describe("conversationToMarkdown", () => {
  it("renders header + metadata", () => {
    const md = conversationToMarkdown(
      conv([msg({ role: "user", content: "hello" })], {
        title: "Refactor auth",
        mode: "council",
        phase: "plan",
        provider: "openai",
        model: "gpt-x",
      }),
    );
    expect(md).toContain("# Refactor auth");
    expect(md).toContain("**Mode:** council · **Phase:** plan");
    expect(md).toContain("**Model:** openai / gpt-x");
    expect(md).toContain("**Messages:** 1");
  });

  it("falls back to a generic title when blank", () => {
    const md = conversationToMarkdown(
      conv([msg({ role: "user", content: "hi" })], { title: "   " }),
    );
    expect(md).toContain("# Zelari session");
  });

  it("renders user and assistant sections in order", () => {
    const md = conversationToMarkdown(
      conv([
        msg({ role: "user", content: "do the thing" }),
        msg({ role: "assistant", content: "done!" }),
      ]),
    );
    const userIdx = md.indexOf("## User");
    const asstIdx = md.indexOf("## Zelari");
    expect(userIdx).toBeGreaterThan(-1);
    expect(asstIdx).toBeGreaterThan(userIdx);
    expect(md).toContain("do the thing");
    expect(md).toContain("done!");
  });

  it("attributes council replies to the member name", () => {
    const md = conversationToMarkdown(
      conv([msg({ role: "assistant", memberName: "Caronte", content: "plan" })]),
    );
    expect(md).toContain("## Caronte");
    expect(md).not.toContain("## Zelari");
  });

  it("filters tool messages and legacy headless system noise", () => {
    const md = conversationToMarkdown(
      conv([
        msg({ role: "tool", content: "read_file result" }),
        msg({ role: "system", content: "[headless] mode=agent" }),
        msg({ role: "system", content: "[headless] MCP tools: foo" }),
        msg({ role: "user", content: "keep me" }),
      ]),
    );
    expect(md).not.toContain("read_file result");
    expect(md).not.toContain("[headless]");
    expect(md).toContain("keep me");
    expect(md).toContain("**Messages:** 1");
  });

  it("filters thinking-only reasoning streams", () => {
    const md = conversationToMarkdown(
      conv([
        msg({ role: "assistant", meta: "thinking", content: "internal reasoning" }),
        msg({ role: "assistant", content: "final answer" }),
      ]),
    );
    expect(md).not.toContain("internal reasoning");
    expect(md).toContain("final answer");
  });

  it("scrubs tool-call scaffolding from assistant prose", () => {
    const md = conversationToMarkdown(
      conv([
        msg({
          role: "assistant",
          content: "Here is the plan<tool_call>read_file</tool_call> — done.",
        }),
      ]),
    );
    expect(md).not.toContain("<tool_call>");
    expect(md).toContain("Here is the plan — done.");
  });

  it("strips the private QUESTION channel from exported prose", () => {
    const md = conversationToMarkdown(
      conv([
        msg({
          role: "assistant",
          content:
            'Intro\n---QUESTION---\n{"q":"pick","choices":["a","b"]}\n---END---\nOutro',
        }),
      ]),
    );
    expect(md).not.toContain("---QUESTION---");
    expect(md).toContain("Intro");
    expect(md).toContain("Outro");
  });

  it("drops assistant messages that scrub to empty", () => {
    const md = conversationToMarkdown(
      conv([
        msg({ role: "assistant", content: "<tool_call>x</tool_call>" }),
        msg({ role: "user", content: "still here" }),
      ]),
    );
    expect(md).not.toContain("## Zelari");
    expect(md).toContain("still here");
  });

  it("renders residual system messages as blockquotes", () => {
    const md = conversationToMarkdown(
      conv([msg({ role: "system", content: "note line" })]),
    );
    expect(md).toContain("> note line");
  });
});

describe("slugifyTitle", () => {
  it("lowercases and dashes non-alphanumerics", () => {
    expect(slugifyTitle("My Cool Session!")).toBe("my-cool-session");
  });

  it("strips Windows-unsafe characters", () => {
    // Unsafe chars are removed (adjacent letters join); the result is a
    // valid, filesystem-safe slug.
    expect(slugifyTitle('a<b>c:d"e/f\\g|h?i*j')).toBe("abcdefghij");
    // Unsafe chars surrounded by spaces collapse to dashes.
    expect(slugifyTitle("a < b")).toBe("a-b");
  });

  it("falls back to 'chat' for empty / symbol-only titles", () => {
    expect(slugifyTitle("")).toBe("chat");
    expect(slugifyTitle("!!!")).toBe("chat");
  });

  it("caps length and trims trailing dashes", () => {
    const slug = slugifyTitle("a".repeat(80));
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("exportFileName", () => {
  it("composes zelari-<slug>-<timestamp>.md", () => {
    const name = exportFileName(
      conv([msg({ role: "user", content: "hi" })], { title: "Fix bug" }),
    );
    expect(name).toMatch(/^zelari-fix-bug-\d{8}-\d{4}\.md$/);
  });
});

describe("hasExportableMessages", () => {
  it("is false for empty / tool-only conversations", () => {
    expect(hasExportableMessages(conv([]))).toBe(false);
    expect(hasExportableMessages(conv([msg({ role: "tool", content: "x" })]))).toBe(
      false,
    );
  });

  it("is true when a user or assistant message has content", () => {
    expect(
      hasExportableMessages(conv([msg({ role: "user", content: "hi" })])),
    ).toBe(true);
    expect(
      hasExportableMessages(conv([msg({ role: "assistant", content: "yo" })])),
    ).toBe(true);
  });

  it("ignores blank assistant messages", () => {
    expect(
      hasExportableMessages(conv([msg({ role: "assistant", content: "   " })])),
    ).toBe(false);
  });
});
