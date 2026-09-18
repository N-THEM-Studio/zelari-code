/**
 * Accent color (Settings → Appearance): the pure helpers plus the prefs
 * round-trip. Auto = no `accentColor` key, so the stylesheet palette wins.
 */
import { describe, expect, it } from "vitest";
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT_COLOR,
  accentStyle,
  normalizeAccentColor,
  onAccentFor,
} from "./accent";
import {
  DEFAULT_DESKTOP_PREFS,
  DESKTOP_PREFS_KEY,
  loadDesktopPrefs,
  normalizeDesktopPrefs,
  patchDesktopPrefs,
} from "../desktopPrefs";

describe("normalizeAccentColor", () => {
  it("accepts #rrggbb, trimmed and case-folded", () => {
    expect(normalizeAccentColor("  #8B7CFF ")).toBe("#8b7cff");
  });

  it("maps unset and malformed values onto Auto (null)", () => {
    for (const bad of ["", "  ", "cyan", "#12345", "#1234567", 42, null, undefined, {}]) {
      expect(normalizeAccentColor(bad)).toBeNull();
    }
  });
});

describe("onAccentFor", () => {
  it("keeps dark text on every bright preset", () => {
    for (const p of ACCENT_PRESETS) {
      expect(onAccentFor(p.color)).toBe("#0b0c10");
    }
  });

  it("flips to white on a dark accent", () => {
    expect(onAccentFor("#1e3a8a")).toBe("#ffffff");
  });
});

describe("accentStyle", () => {
  it("is a no-op in Auto mode", () => {
    expect(accentStyle(undefined)).toBeUndefined();
    expect(accentStyle("")).toBeUndefined();
  });

  it("sets --accent and --on-accent for a palette entry", () => {
    expect(accentStyle(DEFAULT_ACCENT_COLOR)).toMatchObject({
      "--accent": DEFAULT_ACCENT_COLOR,
      "--on-accent": "#0b0c10",
    });
  });
});

describe("desktopPrefs — accent overrides", () => {
  it("leaves the key out by default (Auto)", () => {
    expect(DEFAULT_DESKTOP_PREFS.accentColor).toBeUndefined();
    expect("accentColor" in normalizeDesktopPrefs({})).toBe(false);
  });

  it("round-trips a pick and drops it again when cleared", () => {
    const stored = patchDesktopPrefs(DEFAULT_DESKTOP_PREFS, {
      accentColor: "#f5b642",
    });
    expect(stored.accentColor).toBe("#f5b642");
    expect(
      patchDesktopPrefs(stored, { accentColor: "" }).accentColor,
    ).toBeUndefined();
  });

  it("sanitizes a persisted junk value to Auto", () => {
    const bag: Record<string, string> = {
      [DESKTOP_PREFS_KEY]: JSON.stringify({ accentColor: "not-a-color" }),
    };
    const storage = {
      getItem: (k: string): string | null => bag[k] ?? null,
    };
    expect(loadDesktopPrefs(storage).accentColor).toBeUndefined();
  });
});
