/**
 * Baffetti theme — selectable color for the brand mark (titlebar + empty state).
 *
 * One master color; two intensity variants are derived at runtime (no deps):
 *   --baffo-strong   deeper edge tone (more intense)
 *   --baffo-master   the chosen color
 *   --baffo-soft     lighter highlight tone (less intense)
 * The mark itself is a CSS mask over the logo PNG, so the tint follows the
 * exact shape. Scope: ONLY the baffetti — the rest of the UI keeps --accent.
 */
export interface BaffettiPreset {
  id: string;
  label: string;
  color: string;
}

export const BAFFETTI_PRESETS: readonly BaffettiPreset[] = [
  { id: "silver", label: "Silver", color: "#d8d8dc" },
  { id: "crimson", label: "Crimson", color: "#ff5d5d" },
  { id: "ember", label: "Ember", color: "#ff9f43" },
  { id: "amber", label: "Amber", color: "#ffd166" },
  { id: "mint", label: "Mint", color: "#6ee7a0" },
  { id: "azure", label: "Azure", color: "#5cc8ff" },
  { id: "violet", label: "Violet", color: "#8b7cff" },
  { id: "magenta", label: "Magenta", color: "#ff7ad9" },
] as const;

export const DEFAULT_MUSTACHE_COLOR = "#d8d8dc";

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** Unknown / malformed colors fall back to the silver default. */
export function normalizeMustacheColor(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_MUSTACHE_COLOR;
  const v = value.trim().toLowerCase();
  return HEX_RE.test(v) ? v : DEFAULT_MUSTACHE_COLOR;
}

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToCss([r, g, b]: Rgb): string {
  return `rgb(${r}, ${g}, ${b})`;
}

/** Linear mix of `rgb` toward `target` by `amount` (0..1). */
function mix(rgb: Rgb, target: Rgb, amount: number): Rgb {
  return rgb.map((c, i) =>
    Math.round(c + (target[i] - c) * amount),
  ) as Rgb;
}

export interface BaffettiVariants {
  /** The chosen master color. */
  master: string;
  /** More intense variant — deeper tone for the mark's edge. */
  strong: string;
  /** Less intense variant — lighter tone for the mark's highlight. */
  soft: string;
  /** Translucent master for glows/shadows. */
  glow: string;
}

/** Derive the two intensity variants from the master color (pure, testable). */
export function baffettiVariants(color: string): BaffettiVariants {
  const master = normalizeMustacheColor(color);
  const rgb = hexToRgb(master);
  return {
    master,
    strong: rgbToCss(mix(rgb, [16, 16, 22], 0.38)),
    soft: rgbToCss(mix(rgb, [255, 255, 255], 0.42)),
    glow: `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.38)`,
  };
}

/**
 * Push the baffetti CSS vars onto the document root.
 * No-op outside a DOM (unit tests / SSR).
 */
export function applyBaffettiTheme(color: string): void {
  if (typeof document === "undefined") return;
  const v = baffettiVariants(color);
  const style = document.documentElement.style;
  style.setProperty("--baffo-master", v.master);
  style.setProperty("--baffo-strong", v.strong);
  style.setProperty("--baffo-soft", v.soft);
  style.setProperty("--baffo-glow", v.glow);
}
