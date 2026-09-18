/**
 * tuiPalette.ts — the SINGLE source of truth for the colors of the Ink TUI.
 *
 * Every color painted by `src/cli/components/*` resolves to a token here, so
 * retuning the UI is a one-file edit instead of a grep across components, and
 * two surfaces can never drift into "almost the same" accent.
 *
 * Design rules:
 *
 *  - Ink NAMED colors only (chalk keywords). They map onto the 16 ANSI slots
 *    that every terminal renders — including Windows conhost / legacy
 *    consoles — so the UI never depends on truecolor support.
 *  - Restrained on purpose: accents belong to branding (brand / brandAlt) and
 *    to state (success / warn / danger / info). Message bodies and scrollback
 *    stay uncolored.
 *  - Duo-tone brand: the emblem/art is `brand`, the wordmark is `brandAlt`.
 *
 * The palette is frozen by `as const`; a token's inferred literal type IS the
 * set of legal TUI colors (`TuiColor`).
 */

export const TUI_PALETTE = {
  /** Primary brand accent — emblem/art, prompt caret, identity chips. */
  brand: 'cyan',
  /** Secondary brand accent — wordmark, council/kraken chips, queue. */
  brandAlt: 'magenta',
  /** Positive state — ok, done, build phase, read-only tools. */
  success: 'green',
  /** Attention / in-progress — plan phase, timers, writes, todos. */
  warn: 'yellow',
  /** Failure — errors, destructive shell tools, kraken mode. */
  danger: 'red',
  /** Neutral information — paths, context meter. */
  info: 'blue',
  /** De-emphasized text — hints, idle state. */
  muted: 'gray',
  /** Idle border of the input surfaces. */
  border: 'gray',
  /** Border of the surface that currently owns the keyboard. */
  borderFocus: 'cyan',
  /** Default foreground for labeled items with no state attached. */
  text: 'white',
} as const;

/** Any color the TUI may paint — the values of `TUI_PALETTE`. */
export type TuiColor = (typeof TUI_PALETTE)[keyof typeof TUI_PALETTE];

/**
 * Dispatch-mode accent: `council` → brandAlt, `zelari` → success,
 * `kraken` → danger, anything else → brand.
 */
export function modeColor(mode: string): TuiColor {
  if (mode === 'council') return TUI_PALETTE.brandAlt;
  if (mode === 'zelari') return TUI_PALETTE.success;
  if (mode === 'kraken') return TUI_PALETTE.danger;
  return TUI_PALETTE.brand;
}
