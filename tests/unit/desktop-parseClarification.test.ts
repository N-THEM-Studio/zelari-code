/**
 * Desktop clarification parser (mirrors core; kept in apps/desktop).
 * Tests live under monorepo tests/ and import via relative path.
 */
import { describe, it, expect } from "vitest";
import {
  parseClarificationRequest,
  stripQuestionBlocks,
  hasQuestionMarker,
  hasIncompleteQuestionBlock,
} from "../../apps/desktop/src/components/parseClarification";

describe("desktop parseClarification", () => {
  it("parses a closed QUESTION block", () => {
    const text = `Intro
---QUESTION---
{"question":"Install Playwright?","choices":["Yes, install now","Skip"],"context":"Needed for browser_check"}
---END---
`;
    const c = parseClarificationRequest(text);
    expect(c?.question).toBe("Install Playwright?");
    expect(c?.choices).toEqual(["Yes, install now", "Skip"]);
    expect(stripQuestionBlocks(text)).toBe("Intro");
  });

  it("parses QUESTION without ---END---", () => {
    const text =
      '---QUESTION--- {"question":"Come gioco?","choices":["Apri index.html","Serve static + browser"],"context":"next step"}';
    const c = parseClarificationRequest(text);
    expect(c?.question).toContain("gioco");
    expect(c?.choices?.length).toBe(2);
  });

  it("detects incomplete marker without valid JSON", () => {
    const text = "Hello\n---QUESTION---\n";
    expect(hasQuestionMarker(text)).toBe(true);
    expect(parseClarificationRequest(text)).toBeNull();
    // Mention (no `{` after the marker) stays in prose — do not EOF-wipe.
    expect(stripQuestionBlocks(text)).toContain("---QUESTION---");
    expect(stripQuestionBlocks(text)).toContain("Hello");
  });

  it("keeps a marker mention and strips only a following real block", () => {
    const text = `See \`---QUESTION---\` in the protocol.
---QUESTION---
{"question":"Install Playwright?","choices":["Yes","Skip"]}
---END---
After.`;
    expect(stripQuestionBlocks(text)).toContain("---QUESTION---");
    expect(stripQuestionBlocks(text)).toContain("See");
    expect(stripQuestionBlocks(text)).toContain("After.");
    expect(stripQuestionBlocks(text)).not.toContain("Install Playwright");
  });

  it("hides an incomplete JSON block from the marker through EOF", () => {
    const text = "Hello\n---QUESTION---\n{\"question\":";
    expect(stripQuestionBlocks(text)).toBe("Hello");
    expect(hasIncompleteQuestionBlock(text)).toBe(true);
  });

  it("does not flag a marker mention as an incomplete question", () => {
    const text = "ClarificationCard renders `---QUESTION---` blocks in chat.";
    expect(hasQuestionMarker(text)).toBe(true);
    expect(hasIncompleteQuestionBlock(text)).toBe(false);
  });
});
