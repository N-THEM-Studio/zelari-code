/**
 * mode — the free-form dispatch mode (agent / council / zelari) shared by the
 * shift+tab toggle and the `/mode` command.
 *
 * Kept as a tiny pure module so the cycle order is unit-testable and both the
 * keyboard handler (app.tsx) and the slash command (useSlashDispatch) agree on
 * exactly one source of truth.
 */

import type { ChatMode } from './components/StatusBar.js';

/** Cycle order for shift+tab. */
export const MODES: readonly ChatMode[] = ['agent', 'council', 'zelari'] as const;

/** Next mode in the cycle (wraps agent → council → zelari → agent). */
export function nextMode(current: ChatMode): ChatMode {
  const i = MODES.indexOf(current);
  return MODES[(i + 1) % MODES.length] ?? 'agent';
}

/** Parse a mode name (case-insensitive), or null if unrecognized. */
export function parseMode(input: string): ChatMode | null {
  const v = input.trim().toLowerCase();
  return (MODES as readonly string[]).includes(v) ? (v as ChatMode) : null;
}

/** Short human description of what each mode does (for `/mode` feedback). */
export function describeMode(mode: ChatMode): string {
  switch (mode) {
    case 'council':
      return 'council — 6-member pipeline (Caronte…Lucifero)';
    case 'zelari':
      return 'zelari — autonomous multi-run mission';
    default:
      return 'agent — single LLM turn';
  }
}
