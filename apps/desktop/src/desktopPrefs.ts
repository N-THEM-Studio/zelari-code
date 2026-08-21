/**
 * Desktop execution prefs (profile, verification gates, experiments).
 *
 * Persisted in localStorage so Settings and the composer stay in lockstep.
 * Pure helpers — unit-tested under tests/unit/desktop-prefs.test.ts.
 */
export const DESKTOP_PREFS_KEY = "zelari-desktop-prefs-v2";

export const EXECUTION_PROFILES = [
  "minimal/v1",
  "kraken/v1",
  "council/v1",
  "mission/v1",
] as const;

export type ExecutionProfile = (typeof EXECUTION_PROFILES)[number];

/** `null` preserves the CLI's automatic verifier-selection behaviour. */
export type VerifierReviewPreference = boolean | null;

export interface DesktopPrefs {
  profile: ExecutionProfile;
  /** Strict evidence gate for Kraken runs (off by default). */
  strictDone: boolean;
  /** Strict evidence gate for Mission/Zelari runs (on by default). */
  missionStrict: boolean;
  /** Run the native typecheck/test/build criteria pack. */
  verifyPack: boolean;
  /** Advisory verifier: null = automatic, boolean = explicit override. */
  verifierReview: VerifierReviewPreference;
  /** Experimental Best-of-N (N=3). Requires ZELARI_EXPERIMENTAL=bon on the CLI. */
  bonAlpha: boolean;
  /** Host-driven Gauntlet loop (`--gauntlet` on the CLI). */
  gauntletLoop: boolean;
}

export const DEFAULT_DESKTOP_PREFS: DesktopPrefs = {
  profile: "kraken/v1",
  strictDone: false,
  missionStrict: true,
  verifyPack: false,
  verifierReview: null,
  bonAlpha: false,
  gauntletLoop: false,
};

export function isExecutionProfile(value: unknown): value is ExecutionProfile {
  return (
    typeof value === "string" &&
    (EXECUTION_PROFILES as readonly string[]).includes(value)
  );
}

/** Normalize a stored blob; unknown / missing fields fall back to defaults. */
export function normalizeDesktopPrefs(raw: unknown): DesktopPrefs {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_DESKTOP_PREFS };
  const r = raw as Record<string, unknown>;
  return {
    profile: isExecutionProfile(r.profile)
      ? r.profile
      : DEFAULT_DESKTOP_PREFS.profile,
    strictDone: r.strictDone === true,
    missionStrict:
      typeof r.missionStrict === "boolean"
        ? r.missionStrict
        : DEFAULT_DESKTOP_PREFS.missionStrict,
    verifyPack: r.verifyPack === true,
    verifierReview:
      typeof r.verifierReview === "boolean" ? r.verifierReview : null,
    bonAlpha: r.bonAlpha === true,
    gauntletLoop: r.gauntletLoop === true,
  };
}

export function loadDesktopPrefs(
  storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined"
    ? null
    : localStorage,
): DesktopPrefs {
  if (!storage) return { ...DEFAULT_DESKTOP_PREFS };
  try {
    const raw = storage.getItem(DESKTOP_PREFS_KEY);
    if (!raw) return { ...DEFAULT_DESKTOP_PREFS };
    return normalizeDesktopPrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_DESKTOP_PREFS };
  }
}

export function saveDesktopPrefs(
  prefs: DesktopPrefs,
  storage: Pick<Storage, "setItem"> | null = typeof localStorage === "undefined"
    ? null
    : localStorage,
): void {
  if (!storage) return;
  try {
    storage.setItem(DESKTOP_PREFS_KEY, JSON.stringify(normalizeDesktopPrefs(prefs)));
  } catch {
    /* quota / private mode */
  }
}
