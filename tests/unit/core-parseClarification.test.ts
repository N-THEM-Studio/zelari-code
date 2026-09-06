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

  it("does not treat a marker mention as an interactive clarification", () => {
    const text =
      'ClarificationCard renders `---QUESTION---` blocks in chat, not as a dialog.';
    expect(parseClarificationRequest(text)).toBeNull();
    expect(hasInteractiveClarification(text)).toBe(false);
  });

  it("does not pause on a choices code sample that is not a question block", () => {
    const text =
      'The picker offers `"choices": ["Allow", "Deny"]` next to `---QUESTION---` docs.';
    expect(hasInteractiveClarification(text)).toBe(false);
  });
});
