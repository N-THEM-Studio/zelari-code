/**
 * statuslineItems.test.ts — t114: the status-line vocabulary must be a FAITHFUL
 * mirror of the chips `<StatusBar>` paints today.
 *
 * Red-if-reopens: `STATUS_BAR_PAINT_ORDER` is the literal paint order of
 * StatusBar.tsx (left group: phase → mode → verify → permissions → jail →
 * provider → model → cwd; right group: elapsed → queue → todos → krakenLive →
 * krakenGraph → context → cost → session). Reordering, renaming or dropping a
 * chip in the bar without updating the default configuration fails HERE — that
 * is the acceptance "default = exactly today's chips, zero visible change
 * without an opt-in".
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_STATUSLINE_ITEMS,
  STATUSLINE_CUSTOM_ID,
  STATUSLINE_ITEM_IDS,
  STATUSLINE_ITEMS,
  formatStatusLineItems,
  isStatusLineItemId,
  resolveStatusLineItems,
  statusLineItemLabel,
} from './statuslineItems.js';

/** How StatusBar.tsx paints the chips, in order (single 'elapsed' = busy timer | 'last'). */
const STATUS_BAR_PAINT_ORDER = [
  'phase',
  'mode',
  'verify',
  'permissions',
  'jail',
  'provider',
  'model',
  'cwd',
  'elapsed',
  'queue',
  'todos',
  'krakenLive',
  'krakenGraph',
  'context',
  'cost',
  'session',
];

describe('DEFAULT_STATUSLINE_ITEMS — the chips of today, in the current order (t114)', () => {
  it('is exactly the StatusBar paint order (no chip added, lost or moved)', () => {
    expect([...DEFAULT_STATUSLINE_ITEMS]).toEqual(STATUS_BAR_PAINT_ORDER);
  });

  it('has no duplicate id and the catalog lists every id, in the same order', () => {
    expect(new Set(DEFAULT_STATUSLINE_ITEMS).size).toBe(DEFAULT_STATUSLINE_ITEMS.length);
    expect(STATUSLINE_ITEMS.map((i) => i.id)).toEqual([...STATUS_BAR_PAINT_ORDER, STATUSLINE_CUSTOM_ID]);
    expect([...STATUSLINE_ITEM_IDS]).toEqual([...STATUS_BAR_PAINT_ORDER, STATUSLINE_CUSTOM_ID]);
  });

  it('recognizes every built-in plus custom, and rejects anything else', () => {
    for (const id of DEFAULT_STATUSLINE_ITEMS) expect(isStatusLineItemId(id)).toBe(true);
    expect(isStatusLineItemId(STATUSLINE_CUSTOM_ID)).toBe(true);
    expect(isStatusLineItemId('MODEL')).toBe(false); // ids are case-sensitive
    expect(isStatusLineItemId('')).toBe(false);
    expect(isStatusLineItemId('totally-unknown')).toBe(false);
  });

  it('labels every catalog entry and falls back to the raw id', () => {
    for (const item of STATUSLINE_ITEMS) {
      expect(statusLineItemLabel(item.id)).toBe(item.label);
      expect(item.description.length).toBeGreaterThan(0);
    }
    expect(statusLineItemLabel('nope')).toBe('nope');
  });
});

describe('resolveStatusLineItems — ordered, never an empty chip (t114)', () => {
  it('keeps the configured order and skips items with nothing to say', () => {
    const values = { queue: 'queue 2', phase: undefined, model: 'grok-4.5', cost: '   ' };
    expect(resolveStatusLineItems(values, ['queue', 'phase', 'model', 'cost', 'session'])).toEqual([
      { id: 'queue', text: 'queue 2' },
      { id: 'model', text: 'grok-4.5' },
    ]);
  });

  it('honours the user order, not the default one', () => {
    const values = { phase: 'build', model: 'grok-4.5' };
    expect(resolveStatusLineItems(values, ['model', 'phase']).map((i) => i.id)).toEqual(['model', 'phase']);
    expect(resolveStatusLineItems(values, ['phase', 'model']).map((i) => i.id)).toEqual(['phase', 'model']);
  });

  it('trims the text and drops empty/whitespace/null values', () => {
    const values = { model: '  grok-4.5  ', phase: '', cwd: '   ', session: null };
    expect(resolveStatusLineItems(values, ['model', 'phase', 'cwd', 'session'])).toEqual([
      { id: 'model', text: 'grok-4.5' },
    ]);
  });

  it('takes the custom text from the script result, never from the value map', () => {
    expect(resolveStatusLineItems({ [STATUSLINE_CUSTOM_ID]: 'IGNORED' }, [STATUSLINE_CUSTOM_ID], null)).toEqual([]);
    expect(
      resolveStatusLineItems({ [STATUSLINE_CUSTOM_ID]: 'IGNORED' }, [STATUSLINE_CUSTOM_ID], 'from script'),
    ).toEqual([{ id: STATUSLINE_CUSTOM_ID, text: 'from script' }]);
  });

  it('ignores unknown ids and an empty configuration', () => {
    expect(resolveStatusLineItems({ model: 'm' }, [])).toEqual([]);
    expect(resolveStatusLineItems({ model: 'm' }, ['nope'])).toEqual([]);
  });
});

describe('formatStatusLineItems — the /statusline on-off listing (t114)', () => {
  it('renders one [x]/[ ] line per catalog entry, alphabetically stable', () => {
    const lines = formatStatusLineItems(['jail']).split('\n');
    expect(lines).toHaveLength(STATUSLINE_ITEMS.length);
    expect(lines[0]).toContain('[ ] phase');
    expect(formatStatusLineItems(['jail'])).toContain('[x] jail');
    expect(formatStatusLineItems(['jail'])).not.toContain('[x] phase');
  });

  it('marks everything enabled for the default configuration (custom stays off)', () => {
    const text = formatStatusLineItems(DEFAULT_STATUSLINE_ITEMS);
    expect(text).toContain('[x] phase');
    expect(text).toContain('[ ] custom');
  });
});
