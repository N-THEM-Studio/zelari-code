import { describe, expect, it } from "vitest";
import {
  GAUNTLET_LOOP_MARKER,
  GAUNTLET_LOOP_PROMPT,
  appendGauntletLoop,
  hasGauntletLoop,
  stripGauntletLoop,
} from "../../apps/desktop/src/gauntletLoop";

describe("appendGauntletLoop", () => {
  it("appends the loop block after the user Goal", () => {
    const out = appendGauntletLoop("migliora l'illuminazione");
    expect(out.startsWith("migliora l'illuminazione")).toBe(true);
    expect(out).toContain(GAUNTLET_LOOP_MARKER);
    expect(out).toContain("fan out a specialist builder");
    expect(out).toContain("ruthless critic");
  });

  it("is idempotent when the block is already present", () => {
    const once = appendGauntletLoop("goal");
    expect(appendGauntletLoop(once)).toBe(once);
  });

  it("still emits the block when the Goal is empty", () => {
    expect(appendGauntletLoop("")).toBe(GAUNTLET_LOOP_PROMPT);
    expect(appendGauntletLoop("   ")).toBe(GAUNTLET_LOOP_PROMPT);
  });
});

describe("stripGauntletLoop", () => {
  it("returns the Goal for chat display", () => {
    const sent = appendGauntletLoop("fix the lights");
    expect(stripGauntletLoop(sent)).toBe("fix the lights");
    expect(hasGauntletLoop(sent)).toBe(true);
    expect(hasGauntletLoop("fix the lights")).toBe(false);
  });
});
