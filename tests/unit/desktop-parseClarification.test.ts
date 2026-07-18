/**
 * Desktop clarification parser (mirrors core; kept in apps/desktop).
 * Tests live under monorepo tests/ and import via relative path.
 */
import { describe, it, expect } from "vitest";
import {
  parseClarificationRequest,
  stripQuestionBlocks,
  hasQuestionMarker,
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
    expect(stripQuestionBlocks(text)).toBe("Hello");
  });
});
