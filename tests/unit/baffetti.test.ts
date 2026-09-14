/**
 * Baffetti theme — master color + two intensity variants (pure helpers).
 */
import { describe, expect, it } from "vitest";
import {
  BAFFETTI_PRESETS,
  DEFAULT_MUSTACHE_COLOR,
  baffettiVariants,
  normalizeMustacheColor,
} from "../../apps/desktop/src/theme/baffetti";
import { normalizeDesktopPrefs } from "../../apps/desktop/src/desktopPrefs";

function luminance(css: string): number {
  const hex = /^#([0-9a-f]{6})$/i.exec(css);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return luminance(`rgb(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff})`);
  }
  const m = /rgba?\((\d+), (\d+), (\d+)/.exec(css);
  if (!m) throw new Error(`not a color: ${css}`);
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe("normalizeMustacheColor", () => {
  it("accepts a valid #rrggbb", () => {
    expect(normalizeMustacheColor("#ff5d5d")).toBe("#ff5d5d");
  });

  it("lowercases and trims uppercase input", () => {
    expect(normalizeMustacheColor("  #FF5D5D ")).toBe("#ff5d5d");
  });

  it("falls back to silver on malformed values", () => {
    expect(normalizeMustacheColor("red")).toBe(DEFAULT_MUSTACHE_COLOR);
    expect(normalizeMustacheColor("#12345")).toBe(DEFAULT_MUSTACHE_COLOR);
    expect(normalizeMustacheColor("#1234567")).toBe(DEFAULT_MUSTACHE_COLOR);
    expect(normalizeMustacheColor(42)).toBe(DEFAULT_MUSTACHE_COLOR);
  });

  it("prefs normalize fills the field with the default", () => {
    expect(normalizeDesktopPrefs({}).mustacheColor).toBe(DEFAULT_MUSTACHE_COLOR);
    expect(
      normalizeDesktopPrefs({ mustacheColor: "nonsense" }).mustacheColor,
    ).toBe(DEFAULT_MUSTACHE_COLOR);
  });

  it("prefs normalize keeps a valid stored color", () => {
    expect(normalizeDesktopPrefs({ mustacheColor: "#5cc8ff" }).mustacheColor).toBe(
      "#5cc8ff",
    );
  });
});

describe("baffettiVariants", () => {
  it("keeps the master and orders intensity: strong < master < soft", () => {
    const v = baffettiVariants("#ff5d5d");
    expect(v.master).toBe("#ff5d5d");
    expect(luminance(v.strong)).toBeLessThan(luminance(v.master));
    expect(luminance(v.master)).toBeLessThan(luminance(v.soft));
  });

  it("produces distinct variants for every preset", () => {
    for (const p of BAFFETTI_PRESETS) {
      const v = baffettiVariants(p.color);
      expect(v.master).toBe(p.color);
      expect(v.strong).not.toBe(v.soft);
      expect(v.glow.startsWith("rgba(")).toBe(true);
    }
  });

  it("normalizes malformed input before deriving", () => {
    const v = baffettiVariants("nope");
    expect(v.master).toBe(DEFAULT_MUSTACHE_COLOR);
  });
});
