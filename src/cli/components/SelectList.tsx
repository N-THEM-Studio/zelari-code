import React, { useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import { TUI_PALETTE } from './tuiPalette.js';
import { fuzzyMatch } from './fuzzyMatch.js';

export interface SelectItem {
  /** Value dispatched on selection (e.g. a provider id or model id). */
  value: string;
  /** Display label. */
  label: string;
  /** Dim annotation shown after the label (e.g. owner, 'default'). */
  hint?: string;
  /** Marks the currently-active entry (✓) and seeds the initial cursor. */
  current?: boolean;
  /**
   * v2.53: haystack for the live fuzzy filter (multi-term AND — see
   * fuzzyMatch.ts). Declaring it on ANY item turns this picker filterable;
   * pickers that omit it (/provider, /model, /skill) keep the v0.7.10
   * arrow-key-only behavior unchanged.
   */
  searchText?: string;
}

/**
 * Pure windowing helper (exported for tests): index of the first visible
 * item so the cursor stays roughly centered while the list scrolls.
 */
export function windowStart(index: number, count: number, maxVisible: number): number {
  if (count <= maxVisible) return 0;
  const half = Math.floor(maxVisible / 2);
  return Math.max(0, Math.min(index - half, count - maxVisible));
}

/** Anything a terminal can deliver as a literal character (no control codes). */
const PRINTABLE_INPUT = /^[^\u0000-\u001f\u007f]+$/;

interface SelectListProps {
  title: string;
  items: SelectItem[];
  onSelect: (value: string) => void;
  onCancel: () => void;
  /** Max item rows rendered at once; the list windows around the cursor. */
  maxVisible?: number;
  /**
   * Force the fuzzy filter on/off. Default: ON when any item carries a
   * `searchText` (so /sessions filters and every other picker does not).
   */
  filterable?: boolean;
  /** Placeholder on the query line while it is empty. */
  filterPlaceholder?: string;
}

/**
 * SelectList — arrow-key picker rendered in the dynamic region (v0.7.10).
 *
 * Used by `/provider` and `/model` (no args) to make providers and models
 * selectable instead of typed, and by `/sessions` (v2.53) for the fuzzy
 * session picker. The App swaps it in for the InputBar while open, so
 * ink-text-input never competes for keystrokes. ↑/↓ move (with wrap-around),
 * enter selects, esc cancels. Long lists scroll inside a `maxVisible` window
 * so the dynamic region stays under a screen.
 *
 * v2.53 filter: when filterable, typed characters build a query and the list
 * is re-ranked live by `fuzzyMatch` (every whitespace-separated term must
 * match — multi-term AND). An empty query shows the unfiltered list, so the
 * picker behaves exactly like the pre-filter one until the user types.
 * Backspace widens; esc cancels (the query is only ever a view over the list,
 * never state the caller sees).
 */
export function SelectList({
  title,
  items,
  onSelect,
  onCancel,
  maxVisible = 8,
  filterable,
  filterPlaceholder = 'type to filter',
}: SelectListProps): React.ReactElement {
  const firstCurrent = items.findIndex((i) => i.current);
  const [index, setIndex] = useState(firstCurrent === -1 ? 0 : firstCurrent);
  const [query, setQuery] = useState('');
  const { isRawModeSupported } = useStdin();

  const searchable = filterable ?? items.some((i) => (i.searchText ?? '').length > 0);
  // The filter is a VIEW over `items`: with an empty query the original order
  // (and therefore the original picker behavior) is preserved.
  const shown = searchable ? fuzzyMatch(query, items) : items;
  // The active cursor can fall outside the shown list (query narrowed, or
  // `items` changed under a non-empty query) — clamp for keys and render alike.
  const active = shown.length === 0 ? 0 : Math.min(index, shown.length - 1);

  const typeQuery = (next: string): void => {
    setQuery(next);
    setIndex(0); // best match first: the cursor jumps to the head of the list
  };

  useInput(
    (input, key) => {
      if (key.upArrow) {
        setIndex(() => (shown.length === 0 ? 0 : (active - 1 + shown.length) % shown.length));
      } else if (key.downArrow) {
        setIndex(() => (shown.length === 0 ? 0 : (active + 1) % shown.length));
      } else if (key.return) {
        const item = shown[active];
        if (item) onSelect(item.value);
      } else if (key.escape) {
        onCancel();
      } else if (searchable) {
        if (key.backspace || key.delete) typeQuery(query.slice(0, -1));
        else if (PRINTABLE_INPUT.test(input)) typeQuery(query + input);
      }
    },
    { isActive: isRawModeSupported === true },
  );

  const start = windowStart(active, shown.length, maxVisible);
  const visible = shown.slice(start, start + maxVisible);
  const below = shown.length - (start + visible.length);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={TUI_PALETTE.borderFocus}
      paddingX={1}
    >
      <Text bold color={TUI_PALETTE.brand}>{title}</Text>
      {searchable && (
        <Text wrap="truncate">
          {'filter: '}
          {query.length > 0
            ? <Text color={TUI_PALETTE.brandAlt}>{query}</Text>
            : <Text dimColor>{filterPlaceholder}</Text>}
        </Text>
      )}
      {start > 0 && <Text dimColor>  ↑ {start} more</Text>}
      {visible.map((item, i) => {
        const selected = start + i === active;
        return (
          <Text key={item.value} wrap="truncate" color={selected ? TUI_PALETTE.brand : undefined}>
            {selected ? '❯ ' : '  '}
            <Text bold={selected}>{item.label}</Text>
            {item.current ? <Text color={TUI_PALETTE.success}> ✓</Text> : null}
            {item.hint ? <Text dimColor>  {item.hint}</Text> : null}
          </Text>
        );
      })}
      {below > 0 && <Text dimColor>  ↓ {below} more</Text>}
      {shown.length === 0 && <Text dimColor>  no matches — backspace widens</Text>}
      <Text dimColor>
        {searchable
          ? '↑/↓ move · type to filter · enter select · esc cancel'
          : '↑/↓ move · enter select · esc cancel'}
      </Text>
    </Box>
  );
}
