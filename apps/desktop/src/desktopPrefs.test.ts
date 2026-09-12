/**
 * Per-tentacle thinking-effort prefs (Desktop, ADR-0017).
 *
 * The main desktopPrefs suite lives in tests/unit/desktop-prefs.test.ts; the
 * `kraken*Thinking` additions are covered next to the code they exercise. Same
 * value space as the committed CLI side (HeadlessOptions.kraken*Thinking →
 * `ZELARI_KRAKEN_<KIND>_THINKING`): "" = inherit, plus the effort enum.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DESKTOP_PREFS,
  DESKTOP_PREFS_KEY,
  loadDesktopPrefs,
  normalizeDesktopPrefs,
  normalizeThinkingEffort,
  patchDesktopPrefs,
  saveDesktopPrefs,
  TENTACLE_THINKING_OPTIONS,
  THINKING_EFFORTS,
} from "./desktopPrefs";

function storageStub(): {
  storage: { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void };
  bag: Record<string, string>;
} {
  const bag: Record<string, string> = {};
  return {
    bag,
    storage: {
      getItem: (k: string): string | null => bag[k] ?? null,
      setItem: (k: string, v: string): void => {
        bag[k] = v;
      },
    },
  };
}

describe("normalizeThinkingEffort", () => {
  it("accepts every CLI effort, trimmed and case-folded", () => {
    for (const effort of THINKING_EFFORTS) {
      expect(normalizeThinkingEffort(effort)).toBe(effort);
    }
    expect(normalizeThinkingEffort("HIGH")).toBe("high");
    expect(normalizeThinkingEffort("  Xhigh ")).toBe("xhigh");
  });

  it("maps inherit and empty onto the ONE empty inherit value", () => {
    expect(normalizeThinkingEffort("inherit")).toBe("");
    expect(normalizeThinkingEffort("  Inherit ")).toBe("");
    expect(normalizeThinkingEffort("")).toBe("");
    expect(normalizeThinkingEffort(undefined)).toBe("");
  });

  it("sanitizes unknown values to inherit", () => {
    // 'budget:<n>' is a CLI/env-only form: the desktop never sends it.
    expect(normalizeThinkingEffort("budget:4096")).toBe("");
    expect(normalizeThinkingEffort("turbo")).toBe("");
    expect(normalizeThinkingEffort(null)).toBe("");
    expect(normalizeThinkingEffort(3)).toBe("");
    expect(normalizeThinkingEffort({ effort: "high" })).toBe("");
  });
});

describe("desktopPrefs — tentacle thinking overrides", () => {
  it("defaults all three kinds to inherit", () => {
    expect(DEFAULT_DESKTOP_PREFS.krakenExploreThinking).toBe("");
    expect(DEFAULT_DESKTOP_PREFS.krakenGeneralThinking).toBe("");
    expect(DEFAULT_DESKTOP_PREFS.krakenVerifyThinking).toBe("");
    expect(normalizeDesktopPrefs({})).toMatchObject({
      krakenExploreThinking: "",
      krakenGeneralThinking: "",
      krakenVerifyThinking: "",
    });
  });

  it("round-trips the three kinds through save → load", () => {
    const { storage, bag } = storageStub();
    saveDesktopPrefs(
      {
        ...DEFAULT_DESKTOP_PREFS,
        krakenExploreThinking: "low",
        krakenGeneralThinking: "high",
        krakenVerifyThinking: "max",
      },
      storage,
    );
    expect(JSON.parse(bag[DESKTOP_PREFS_KEY]).krakenExploreThinking).toBe("low");
    expect(loadDesktopPrefs(storage)).toMatchObject({
      krakenExploreThinking: "low",
      krakenGeneralThinking: "high",
      krakenVerifyThinking: "max",
    });
  });

  it("patches one kind without disturbing the others (composer path)", () => {
    const saved = patchDesktopPrefs(
      {
        ...DEFAULT_DESKTOP_PREFS,
        krakenGeneralThinking: "medium",
        krakenVerifyThinking: "xhigh",
      },
      { krakenExploreThinking: "off" },
    );
    expect(saved).toMatchObject({
      krakenExploreThinking: "off",
      krakenGeneralThinking: "medium",
      krakenVerifyThinking: "xhigh",
    });
  });

  it("sanitizes unknown persisted values to inherit", () => {
    expect(
      normalizeDesktopPrefs({
        krakenExploreThinking: "turbo",
        krakenGeneralThinking: 42,
        krakenVerifyThinking: "inherit",
        krakenPlannerThinking: "high",
      }),
    ).toMatchObject({
      krakenExploreThinking: "",
      krakenGeneralThinking: "",
      krakenVerifyThinking: "",
    });
  });

  it("offers inherit + the effort enum to the composer", () => {
    expect(TENTACLE_THINKING_OPTIONS[0]).toBe("inherit");
    expect(TENTACLE_THINKING_OPTIONS.slice(1)).toEqual([...THINKING_EFFORTS]);
  });
});
