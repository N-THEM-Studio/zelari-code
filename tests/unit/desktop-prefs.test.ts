import { describe, expect, it } from "vitest";
import {
  DEFAULT_DESKTOP_PREFS,
  DESKTOP_PREFS_KEY,
  isExecutionProfile,
  loadDesktopPrefs,
  normalizeDesktopPrefs,
  saveDesktopPrefs,
} from "../../apps/desktop/src/desktopPrefs";

describe("isExecutionProfile", () => {
  it("accepts the four built-in 2.0 ids", () => {
    expect(isExecutionProfile("minimal/v1")).toBe(true);
    expect(isExecutionProfile("kraken/v1")).toBe(true);
    expect(isExecutionProfile("council/v1")).toBe(true);
    expect(isExecutionProfile("mission/v1")).toBe(true);
  });

  it("rejects typos and empty values", () => {
    expect(isExecutionProfile("kraken")).toBe(false);
    expect(isExecutionProfile("")).toBe(false);
    expect(isExecutionProfile(null)).toBe(false);
  });
});

describe("normalizeDesktopPrefs", () => {
  it("returns defaults for garbage input", () => {
    expect(normalizeDesktopPrefs(null)).toEqual(DEFAULT_DESKTOP_PREFS);
    expect(normalizeDesktopPrefs("x")).toEqual(DEFAULT_DESKTOP_PREFS);
  });

  it("keeps only known fields and coerces booleans", () => {
    expect(
      normalizeDesktopPrefs({
        profile: "minimal/v1",
        strictDone: true,
        missionStrict: false,
        verifyPack: true,
        verifierReview: false,
        bonAlpha: "yes",
        extra: 1,
      }),
    ).toEqual({
      profile: "minimal/v1",
      strictDone: true,
      missionStrict: false,
      verifyPack: true,
      verifierReview: false,
      bonAlpha: false,
    });
  });

  it("migrates old saved prefs without changing runtime defaults", () => {
    expect(
      normalizeDesktopPrefs({
        profile: "kraken/v1",
        strictDone: true,
        bonAlpha: true,
      }),
    ).toEqual({
      profile: "kraken/v1",
      strictDone: true,
      missionStrict: true,
      verifyPack: false,
      verifierReview: null,
      bonAlpha: true,
    });
  });
});

describe("load/saveDesktopPrefs", () => {
  it("round-trips through a Storage stub", () => {
    const bag: Record<string, string> = {};
    const storage = {
      getItem: (k: string) => bag[k] ?? null,
      setItem: (k: string, v: string) => {
        bag[k] = v;
      },
    };
    saveDesktopPrefs(
      {
        profile: "council/v1",
        strictDone: true,
        missionStrict: false,
        verifyPack: true,
        verifierReview: true,
        bonAlpha: true,
      },
      storage,
    );
    expect(bag[DESKTOP_PREFS_KEY]).toContain("council/v1");
    expect(loadDesktopPrefs(storage)).toEqual({
      profile: "council/v1",
      strictDone: true,
      missionStrict: false,
      verifyPack: true,
      verifierReview: true,
      bonAlpha: true,
    });
  });

  it("returns defaults when storage is missing or corrupt", () => {
    expect(loadDesktopPrefs(null)).toEqual(DEFAULT_DESKTOP_PREFS);
    const storage = {
      getItem: () => "{not-json",
    };
    expect(loadDesktopPrefs(storage)).toEqual(DEFAULT_DESKTOP_PREFS);
  });
});
