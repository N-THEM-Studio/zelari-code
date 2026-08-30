import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DESKTOP_PREFS,
  DESKTOP_PREFS_KEY,
  isExecutionProfile,
  loadDesktopPrefs,
  normalizeDelegation,
  normalizeDesktopPrefs,
  normalizeModelOverride,
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

describe("normalizeModelOverride", () => {
  it("trims strings and maps non-strings to empty inherit", () => {
    expect(normalizeModelOverride("fast-model")).toBe("fast-model");
    expect(normalizeModelOverride("  coding-model  ")).toBe("coding-model");
    expect(normalizeModelOverride("   ")).toBe("");
    expect(normalizeModelOverride("")).toBe("");
    expect(normalizeModelOverride(null)).toBe("");
    expect(normalizeModelOverride(false)).toBe("");
    expect(normalizeModelOverride(123)).toBe("");
    expect(normalizeModelOverride({})).toBe("");
  });
});

describe("normalizeDelegation", () => {
  it("accepts the four canonical policies and trims/case-folds", () => {
    expect(normalizeDelegation("automatic")).toBe("automatic");
    expect(normalizeDelegation("prefer")).toBe("prefer");
    expect(normalizeDelegation("aggressive")).toBe("aggressive");
    expect(normalizeDelegation("lead-only")).toBe("lead-only");
    expect(normalizeDelegation("  Lead-Only ")).toBe("lead-only");
  });

  it("falls back to automatic for unknown or missing values", () => {
    expect(normalizeDelegation(undefined)).toBe("automatic");
    expect(normalizeDelegation("")).toBe("automatic");
    expect(normalizeDelegation("wat")).toBe("automatic");
    expect(normalizeDelegation(42)).toBe("automatic");
  });
});

describe("normalizeDesktopPrefs", () => {
  it("returns defaults for garbage input", () => {
    expect(normalizeDesktopPrefs(null)).toEqual(DEFAULT_DESKTOP_PREFS);
    expect(normalizeDesktopPrefs("x")).toEqual(DEFAULT_DESKTOP_PREFS);
  });

  it("defaults Kraken model overrides to inherit", () => {
    expect(DEFAULT_DESKTOP_PREFS.krakenExploreModel).toBe("");
    expect(DEFAULT_DESKTOP_PREFS.krakenGeneralModel).toBe("");
    expect(DEFAULT_DESKTOP_PREFS.krakenVerifyModel).toBe("");
    expect(DEFAULT_DESKTOP_PREFS.krakenPlannerModel).toBe("");
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
        gauntletLoop: true,
        extra: 1,
      }),
    ).toEqual({
      profile: "minimal/v1",
      strictDone: true,
      missionStrict: false,
      verifyPack: true,
      verifierReview: false,
      bonAlpha: false,
      gauntletLoop: true,
      krakenDelegation: "automatic",
      krakenExploreModel: "",
      krakenGeneralModel: "",
      krakenVerifyModel: "",
      krakenPlannerModel: "",
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
      gauntletLoop: false,
      krakenDelegation: "automatic",
      krakenExploreModel: "",
      krakenGeneralModel: "",
      krakenVerifyModel: "",
      krakenPlannerModel: "",
    });
  });

  it("persists Kraken model overrides and rejects invalid types", () => {
    expect(
      normalizeDesktopPrefs({
        profile: "kraken/v1",
        krakenExploreModel: "fast-model",
        krakenGeneralModel: "coding-model",
        krakenVerifyModel: "review-model",
        krakenPlannerModel: "planner-model",
      }),
    ).toEqual({
      ...DEFAULT_DESKTOP_PREFS,
      krakenExploreModel: "fast-model",
      krakenGeneralModel: "coding-model",
      krakenVerifyModel: "review-model",
      krakenPlannerModel: "planner-model",
    });

    expect(
      normalizeDesktopPrefs({
        krakenExploreModel: null,
        krakenGeneralModel: false,
        krakenVerifyModel: 123,
        krakenPlannerModel: {},
      }),
    ).toMatchObject({
      krakenExploreModel: "",
      krakenGeneralModel: "",
      krakenVerifyModel: "",
      krakenPlannerModel: "",
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
        gauntletLoop: true,
        krakenDelegation: "prefer",
        krakenExploreModel: "fast-model",
        krakenGeneralModel: "coding-model",
        krakenVerifyModel: "review-model",
        krakenPlannerModel: "planner-model",
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
      gauntletLoop: true,
      krakenDelegation: "prefer",
      krakenExploreModel: "fast-model",
      krakenGeneralModel: "coding-model",
      krakenVerifyModel: "review-model",
      krakenPlannerModel: "planner-model",
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

describe("strict-done default (W6/t46 flip, post QA t21)", () => {
  it("desktop default aligns with the CLI (strictDone ON, ADR-0025)", () => {
    expect(DEFAULT_DESKTOP_PREFS.strictDone).toBe(true);
    expect(normalizeDesktopPrefs({}).strictDone).toBe(true);
    expect(normalizeDesktopPrefs({ strictDone: false }).strictDone).toBe(false);
  });

  it("sidecar no longer pins ZELARI_STRICT_DONE=0 (inherits the CLI default)", () => {
    const rs = fs.readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../apps/desktop/src-tauri/src/harness_sidecar.rs",
      ),
      "utf8",
    );
    expect(rs).not.toContain('cmd.env("ZELARI_STRICT_DONE"');
  });
});
