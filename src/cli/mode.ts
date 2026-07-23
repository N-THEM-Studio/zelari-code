/**
 * mode — free-form dispatch mode (kraken / council / zelari) shared by the
 * shift+tab toggle and the `/mode` command.
 *
 * Canonical single-implementer mode is **kraken** (senior lead that spawns
 * tentacles via `task`). Legacy name `agent` is accepted as an alias.
 *
 * Kept as a tiny pure module so the cycle order is unit-testable and both the
 * keyboard handler (app.tsx) and the slash command (useSlashDispatch) agree on
 * exactly one source of truth.
 */

import type { ChatMode } from './components/StatusBar.js';

/** Cycle order for shift+tab. */
export const MODES: readonly ChatMode[] = ['kraken', 'council', 'zelari'] as const;

/** Legacy aliases → canonical ChatMode. */
const MODE_ALIASES: Readonly<Record<string, ChatMode>> = {
  agent: 'kraken',
  single: 'kraken',
};

/** True when mode is the single-harness implementer (kraken). */
export function isKrakenMode(mode: string | null | undefined): boolean {
  return mode === 'kraken' || mode === 'agent';
}

/** Next mode in the cycle (wraps kraken → council → zelari → kraken). */
export function nextMode(current: ChatMode): ChatMode {
  const i = MODES.indexOf(current);
  return MODES[(i + 1) % MODES.length] ?? 'kraken';
}

/** Parse a mode name (case-insensitive), or null if unrecognized. */
export function parseMode(input: string): ChatMode | null {
  const v = input.trim().toLowerCase();
  if ((MODES as readonly string[]).includes(v)) return v as ChatMode;
  return MODE_ALIASES[v] ?? null;
}

/** Short human description of what each mode does (for `/mode` feedback). */
export function describeMode(mode: ChatMode): string {
  switch (mode) {
    case 'council':
      return 'council — multi-member plan/design (Caronte…Lucifero; build needs ZELARI_COUNCIL_CAN_BUILD=1)';
    case 'zelari':
      return 'zelari — mission: plan@council → build@kraken (legacy: ZELARI_BUILD_VIA_AGENT=0)';
    default:
      return 'kraken — super-agent lead (spawns explore/general/verify tentacles; default implementer)';
  }
}
