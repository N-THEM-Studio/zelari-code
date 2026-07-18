import { describe, it, expect } from "vitest";
import {
  parseClarificationRequest,
  hasInteractiveClarification,
  cleanAgentContent,
} from "@zelari/core";

describe("parseClarificationRequest (interactive pause)", () => {
  it("parses a clean ---QUESTION--- … ---END--- block", () => {
    const text = `Intro
---QUESTION---
{"question":"Which scope?","choices":["A","B","C"],"context":"pick one"}
---END---
`;
    const c = parseClarificationRequest(text);
    expect(c?.question).toBe("Which scope?");
    expect(c?.choices).toEqual(["A", "B", "C"]);
    expect(hasInteractiveClarification(text)).toBe(true);
  });

  it("parses QUESTION without ---END--- and with MiniMax trailing junk", () => {
    // Live failure mode: model emits QUESTION then garbled tool dump.
    const text =
      '---QUESTION--- {"question":"Per la fase di sviluppo, quale strategia preferisci?", "choices": ["Solo manutenzione totale (nessun codice da toccare)", "Manutenzione + feature flag", "Solo feature flag"], "context":"Decide se serve una patch."}]<]minimax[>[</content>]';
    const c = parseClarificationRequest(text);
    expect(c).not.toBeNull();
    expect(c!.question).toContain("strategia");
    expect(c!.choices?.length).toBe(3);
    expect(hasInteractiveClarification(text)).toBe(true);
  });

  it("cleanAgentContent strips unclosed QUESTION blocks", () => {
    const raw =
      'Ask:\n---QUESTION---\n{"question":"q?","choices":["a","b"]}\n]<]minimax junk';
    const cleaned = cleanAgentContent(raw);
    expect(cleaned).not.toContain("---QUESTION---");
    expect(cleaned).toContain("Ask:");
  });
});
