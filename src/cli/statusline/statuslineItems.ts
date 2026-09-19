/**
 * statuslineItems — the StatusLine vocabulary (t114).
 *
 * The `<StatusBar>` renders a fixed sequence of chips. This module names that
 * sequence so a user configuration can reorder / hide members of it and append
 * ONE `custom` item whose text comes from an external script
 * (see statuslineCustom.ts).
 *
 * DEFAULT = the current order, all enabled — importing this module changes
 * nothing on screen until a user opts in through `/statusline` (or by editing
 * the persisted config). The renderer stays dumb: it asks for the values it
 * already computes and prints the items this resolver returns, in order.
 *
 * Pure: no I/O, no clock, no React. Unknown/invalid ids are dropped, never
 * rendered as empty chips.
 */

/**
 * The canonical chip order — one entry per visible StatusBar item today, in
 * the order `<StatusBar>` paints them (left group first: phase BEFORE mode).
 */
export const DEFAULT_STATUSLINE_ITEMS: readonly string[] = [
  // left box
  'phase',
  'mode',
  'verify',
  'permissions',
  'jail',
  'provider',
  'model',
  'cwd',
  // right box
  'elapsed',
  'queue',
  'todos',
  'krakenLive',
  'krakenGraph',
  'context',
  'cost',
  'session',
];

/** The one item whose text comes from a user script instead of the session. */
export const STATUSLINE_CUSTOM_ID = 'custom';

/**
 * `verdict` — the derive-only verification feed (verdictFeed.ts: counts and
 * phases read back from the session spine's `verification.*` events).
 *
 * OPT-IN, like `custom`: it is a KNOWN, toggleable id that is deliberately NOT
 * in DEFAULT_STATUSLINE_ITEMS, because this default list is pinned to the chips
 * `<StatusBar>` actually paints (see statuslineItems.test.ts) and a projection
 * that no renderer paints yet must not be reported as enabled.
 */
export const STATUSLINE_VERDICT_ID = 'verdict';

/** Any id a configuration may reference (built-ins + the opt-in items). */
export const STATUSLINE_ITEM_IDS: readonly string[] = [
  ...DEFAULT_STATUSLINE_ITEMS,
  STATUSLINE_CUSTOM_ID,
  STATUSLINE_VERDICT_ID,
];

export interface StatusLineItemInfo {
  id: string;
  label: string;
  /** Shown by `/statusline` next to the id. */
  description: string;
}

/** Catalog for `/statusline` (order = the default order). */
export const STATUSLINE_ITEMS: readonly StatusLineItemInfo[] = [
  { id: 'phase', label: 'phase', description: 'work phase (plan | build)' },
  { id: 'mode', label: 'mode', description: 'dispatch mode (kraken | council | zelari)' },
  { id: 'verify', label: 'prova', description: 'strict-done verification chip' },
  { id: 'permissions', label: 'perm', description: 'effective permission preset' },
  { id: 'jail', label: 'jail', description: 'OS-jail honesty chip' },
  { id: 'provider', label: 'provider', description: 'active provider id' },
  { id: 'model', label: 'model', description: 'active model' },
  { id: 'cwd', label: 'cwd', description: 'shortened working directory' },
  { id: 'elapsed', label: 'time', description: 'elapsed / last-run duration' },
  { id: 'queue', label: 'queue', description: 'queued follow-up prompts' },
  { id: 'todos', label: 'todos', description: 'session todo summary' },
  { id: 'krakenLive', label: 'tentacles', description: 'Kraken live tentacle radio' },
  { id: 'krakenGraph', label: 'graph', description: 'Kraken graph-run summary' },
  { id: 'context', label: 'ctx', description: 'context window occupancy' },
  { id: 'cost', label: 'cost', description: 'session cost / cache metrics' },
  { id: 'session', label: 'session', description: 'session id' },
  { id: STATUSLINE_CUSTOM_ID, label: 'custom', description: 'first line of an external script (JSON on stdin)' },
  {
    id: STATUSLINE_VERDICT_ID,
    label: 'verdict',
    description: 'verification progress from spine events (derive-only; opt-in)',
  },
];

/** True when `id` is a known item (built-in, `custom` or `verdict`). */
export function isStatusLineItemId(id: string): boolean {
  return STATUSLINE_ITEM_IDS.includes(id);
}

/** Human label for one id (falls back to the id itself). */
export function statusLineItemLabel(id: string): string {
  return STATUSLINE_ITEMS.find((i) => i.id === id)?.label ?? id;
}

/**
 * The text an item renders right now. `undefined`/empty/whitespace means the
 * item has nothing to say (e.g. cost is 0) — the resolver skips it, exactly
 * like the StatusBar's `{chip ? … : null}` guards do today.
 */
export type StatusLineValues = Readonly<Record<string, string | undefined | null>>;

export interface RenderedStatusLineItem {
  id: string;
  text: string;
}

/**
 * Ordered, non-empty items for the configured list. `customText` is the
 * already-resolved custom item text (undefined ⇒ hidden, which is also the
 * behaviour when the script errors or times out).
 */
export function resolveStatusLineItems(
  values: StatusLineValues,
  items: readonly string[],
  customText?: string | null,
): RenderedStatusLineItem[] {
  const out: RenderedStatusLineItem[] = [];
  for (const id of items) {
    const raw = id === STATUSLINE_CUSTOM_ID ? customText : values[id];
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text.length > 0) out.push({ id, text });
  }
  return out;
}

/** One-line preview used by `/statusline` (id order + enabled/disabled). */
export function formatStatusLineItems(items: readonly string[]): string {
  const enabled = new Set(items);
  return STATUSLINE_ITEMS.map((item) => `${enabled.has(item.id) ? '[x]' : '[ ]'} ${item.id.padEnd(12)} ${item.description}`).join(
    '\n',
  );
}
