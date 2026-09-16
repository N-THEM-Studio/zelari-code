// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { MessageContent, messageContentPropsEqual } from "./MessageContent";

// CopyButton pulls a hook-bearing tree that resolves a second React copy in
// the jsdom test env (pre-existing quirk, works in the real app). The code
// block markup itself is what we assert here, so stub the button out.
vi.mock("./CopyButton", () => ({
  CopyButton: () => <div data-testid="copy-stub" />,
}));

// WeaknessBadge renders on any non-streaming reply containing "VERDICT:" — used
// below as an observable counter of how many times the body actually re-ran.
const weakSpy = vi.hoisted(() => vi.fn());
vi.mock("./WeaknessBadge", () => ({
  WeaknessBadge: (props: { text: string }) => {
    weakSpy(props.text);
    return <div data-testid="weak-stub" />;
  },
}));

describe("MessageContent inline readability", () => {
  it("renders bold, inline code and links instead of stripping them", () => {
    const { container } = render(
      <MessageContent
        content={'**Fatto** con `npm test` e [guida](https://example.com/a)'}
      />,
    );
    expect(container.querySelector("strong.md-strong")?.textContent).toBe(
      "Fatto",
    );
    expect(container.querySelector("code.md-inline-code")?.textContent).toBe(
      "npm test",
    );
    const a = container.querySelector("a.md-link");
    expect(a?.getAttribute("href")).toBe("https://example.com/a");
    expect(a?.textContent).toBe("guida");
  });

  it("keeps block structure: headings, lists, code fence", () => {
    const md = [
      "## Titolo",
      "",
      "- punto **uno**",
      "- punto due",
      "",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n");
    const { container } = render(<MessageContent content={md} />);
    expect(container.querySelector(".md-h2")?.textContent).toBe("Titolo");
    const items = container.querySelectorAll(".md-list li");
    expect(items.length).toBe(2);
    expect(items[0]?.querySelector("strong")).not.toBeNull();
    expect(container.querySelector(".md-code")?.textContent).toContain(
      "const x = 1;",
    );
  });

  it("cleans orphan markers left by streaming", () => {
    const { container } = render(
      <MessageContent content={"testo ** interrotto"} />,
    );
    expect(container.querySelector(".md-p")?.textContent).toBe(
      "testo interrotto",
    );
  });

  it("renders tables with inline formatting in cells", () => {
    const md = ["| a | b |", "| --- | --- |", "| **x** | `y` |"].join("\n");
    const { container } = render(<MessageContent content={md} />);
    const table = container.querySelector(".md-table");
    expect(table?.querySelector("strong")).not.toBeNull();
    expect(table?.querySelector("code")).not.toBeNull();
  });
});

describe("MessageContent memoization (W3.1)", () => {
  it("is wrapped in React.memo so unrelated parent re-renders skip it", () => {
    expect(
      (MessageContent as { $$typeof?: symbol }).$$typeof,
    ).toBe(Symbol.for("react.memo"));
  });
});

/**
 * SLICE2(transcript-memo): the memo is the fix, so test the contract itself —
 * value equality decides, identity does not.
 */
describe("MessageContent SLICE2 memo", () => {
  it("treats value-equal props as equal (fresh objects included)", () => {
    const onChoose = () => {};
    expect(messageContentPropsEqual({ content: "a" }, { content: "a" })).toBe(
      true,
    );
    expect(
      messageContentPropsEqual(
        {
          content: "a",
          streaming: true,
          thinking: false,
          showThinking: false,
          clarificationDisabled: false,
          onClarificationChoose: onChoose,
          stats: { durationMs: 10, toolCount: 1 },
        },
        {
          content: "a",
          streaming: true,
          thinking: false,
          showThinking: false,
          clarificationDisabled: false,
          onClarificationChoose: onChoose,
          // Rebuilt by the parent: same fields, different identity.
          stats: { durationMs: 10, toolCount: 1 },
        },
      ),
    ).toBe(true);
  });

  it("treats any changed field, stat or callback as different", () => {
    const a = () => {};
    const b = () => {};
    const base = {
      content: "a",
      streaming: false,
      clarificationDisabled: false,
      onClarificationChoose: a,
      stats: { durationMs: 10, charCount: 5 },
    };
    expect(messageContentPropsEqual(base, base)).toBe(true);
    expect(messageContentPropsEqual(base, { ...base, content: "b" })).toBe(
      false,
    );
    expect(messageContentPropsEqual(base, { ...base, streaming: true })).toBe(
      false,
    );
    expect(messageContentPropsEqual(base, { ...base, thinking: true })).toBe(
      false,
    );
    expect(messageContentPropsEqual(base, { ...base, showThinking: true })).toBe(
      false,
    );
    expect(
      messageContentPropsEqual(base, { ...base, clarificationDisabled: true }),
    ).toBe(false);
    expect(
      messageContentPropsEqual(base, {
        ...base,
        stats: { durationMs: 11, charCount: 5 },
      }),
    ).toBe(false);
    expect(messageContentPropsEqual(base, { ...base, stats: undefined })).toBe(
      false,
    );
    expect(
      messageContentPropsEqual(base, { ...base, onClarificationChoose: b }),
    ).toBe(false);
  });

  it("skips the re-render (and the re-parse) for value-equal props", () => {
    weakSpy.mockClear();
    const onChoose = () => {};
    const stats = { durationMs: 1200, toolCount: 2 };
    const { rerender } = render(
      <MessageContent
        content={"VERDICT: PASS\n\ncorpo"}
        stats={stats}
        onClarificationChoose={onChoose}
      />,
    );
    expect(weakSpy).toHaveBeenCalledTimes(1);

    // A parent re-render hands down a rebuilt content string and a fresh
    // `stats` object — same values, new identities. The memo must bail out.
    rerender(
      <MessageContent
        content={"VERDICT: PASS" + "\n\n" + "corpo"}
        stats={{ ...stats }}
        onClarificationChoose={onChoose}
      />,
    );
    expect(weakSpy).toHaveBeenCalledTimes(1);

    // A real change still goes through.
    rerender(
      <MessageContent
        content={"VERDICT: PASS\n\ncorpo nuovo"}
        stats={stats}
        onClarificationChoose={onChoose}
      />,
    );
    expect(weakSpy).toHaveBeenCalledTimes(2);
  });
});
