// @vitest-environment jsdom
/**
 * cli-picker.test.ts — v0.7.10 interactive /provider + /model pickers.
 *
 * Covers the pure logic: the model-picker item builder (discovered list +
 * active model + provider default merging) and the SelectList windowing
 * helper. The interactive arrow-key behavior needs raw-mode stdin and is
 * covered by manual verification, same as the rest of the Ink layer.
 */
import { describe, it, expect } from 'vitest';
import { buildModelPickerItems } from '../../src/cli/slashHandlers/provider.js';
import { windowStart } from '../../src/cli/components/SelectList.js';

describe('buildModelPickerItems (v0.7.10)', () => {
  const discovered = [
    { id: 'grok-4', ownedBy: 'xai' },
    { id: 'grok-4-fast', ownedBy: 'xai' },
    { id: 'grok-3-mini' },
  ];

  it('maps discovered models and marks the active one as current', () => {
    const items = buildModelPickerItems(discovered, 'grok-4-fast', 'grok-4');
    expect(items.map((i) => i.value)).toEqual(['grok-4', 'grok-4-fast', 'grok-3-mini']);
    expect(items.find((i) => i.value === 'grok-4-fast')?.current).toBe(true);
    expect(items.find((i) => i.value === 'grok-4')?.current).toBe(false);
    expect(items.find((i) => i.value === 'grok-4')?.hint).toBe('xai');
  });

  it('prepends the active model when discovery is missing it', () => {
    const items = buildModelPickerItems(discovered, 'my-custom-model', 'grok-4');
    expect(items[0]).toMatchObject({ value: 'my-custom-model', hint: 'current', current: true });
    expect(items).toHaveLength(4);
  });

  it('prepends the provider default when discovery is missing it', () => {
    const items = buildModelPickerItems(discovered, 'grok-4', 'glm-4.6');
    expect(items[0]).toMatchObject({ value: 'glm-4.6', hint: 'default', current: false });
  });

  it('falls back to active + default when there are no discovered models', () => {
    const items = buildModelPickerItems([], 'active-model', 'default-model');
    expect(items.map((i) => i.value)).toEqual(['active-model', 'default-model']);
    expect(items[0]?.current).toBe(true);
  });

  it('does not duplicate when active model equals the default', () => {
    const items = buildModelPickerItems([], 'same-model', 'same-model');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ value: 'same-model', current: true });
  });

  it('returns empty when nothing is known at all', () => {
    expect(buildModelPickerItems([], '', undefined)).toEqual([]);
  });
});

describe('SelectList windowStart (v0.7.10)', () => {
  it('returns 0 when everything fits', () => {
    expect(windowStart(0, 5, 8)).toBe(0);
    expect(windowStart(4, 5, 8)).toBe(0);
  });

  it('keeps the cursor centered while scrolling', () => {
    // 20 items, window of 8, cursor at 10 → start at 10 - 4 = 6.
    expect(windowStart(10, 20, 8)).toBe(6);
  });

  it('clamps at the top of the list', () => {
    expect(windowStart(1, 20, 8)).toBe(0);
  });

  it('clamps at the bottom of the list', () => {
    expect(windowStart(19, 20, 8)).toBe(12);
    expect(windowStart(16, 20, 8)).toBe(12);
  });
});
