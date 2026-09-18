/**
 * Accent color — user-selectable UI accent (Settings → Appearance → Accent color).
 *
 * The chosen hex is applied INLINE on the `.app` root as `--accent` (plus the
 * derived `--on-accent` text color). An inline custom property beats every
 * stylesheet declaration on that element - the per-mode palettes and the flat
 * token block included - so every `var(--accent)` consumer in App.css follows,
 * chat included. The secondary tokens (`--accent-soft/-strong/-2`) are
 * re-derived in CSS under `.app[data-accent]`, guarded so that Auto is a no-op.
 *
 * Unset (`null` / invalid / missing) = Auto: the per-mode palette, exactly as
 * before this setting existed. Pure helpers, no deps.
 */
import type { CSSProperties } from "react";

export interface AccentPreset {
  id: string;
  label: string;
  color: string;
}

/** Small curated set — the per-mode defaults plus amber and emerald. */
export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: "cyan", label: "Cyan", color: "#22d3ee" },
  { id: "violet", label: "Violet", color: "#8b7cff" },
  { id: "magenta", label: "Magenta", color: "#e879f9" },
  { id: "amber", label: "Amber", color: "#f5b642" },
  { id: "emerald", label: "Emerald", color: "#34d399" },
] as const;

/** Seed for the custom color input while Auto is active — never persisted. */
export const DEFAULT_ACCENT_COLOR = "#22d3ee";

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** Malformed / unset values return `null`, i.e. Auto (keep the stylesheet palette). */
export function normalizeAccentColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return HEX_RE.test(v) ? v : null;
}

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** WCAG relative luminance of an sRGB triple (0 = black, 1 = white). */
function relativeLuminance([r, g, b]: Rgb): number {
  const linear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/**
 * Text color for a label laid over an accent fill.
 *
 * 0.2 sits on the contrast crossover for our near-black (≈0.19): above it
 * `#0b0c10` wins the ratio, below it `#ffffff` does. Every bright preset
 * (cyan, violet, magenta, amber, emerald) therefore keeps dark text, a dark
 * custom accent gets white.
 */
export function onAccentFor(hex: string): string {
  const accent = normalizeAccentColor(hex) ?? DEFAULT_ACCENT_COLOR;
  return relativeLuminance(hexToRgb(accent)) > 0.2 ? "#0b0c10" : "#ffffff";
}

/**
 * Inline style for the `.app` root, or `undefined` in Auto mode (nothing is
 * set and the stylesheet owns the palette).
 */
export function accentStyle(hex: string | undefined): CSSProperties | undefined {
  const accent = normalizeAccentColor(hex);
  if (!accent) return undefined;
  // `--*` keys are custom properties: legal on the style attribute, absent
  // from React's CSSProperties surface.
  return {
    "--accent": accent,
    "--on-accent": onAccentFor(accent),
  } as CSSProperties;
}
