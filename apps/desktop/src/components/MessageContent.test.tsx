// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { MessageContent } from "./MessageContent";

// CopyButton pulls a hook-bearing tree that resolves a second React copy in
// the jsdom test env (pre-existing quirk, works in the real app). The code
// block markup itself is what we assert here, so stub the button out.
vi.mock("./CopyButton", () => ({
  CopyButton: () => <div data-testid="copy-stub" />,
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
