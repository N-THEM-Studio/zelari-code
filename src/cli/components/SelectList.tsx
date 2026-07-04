import React, { useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';

export interface SelectItem {
  /** Value dispatched on selection (e.g. a provider id or model id). */
  value: string;
  /** Display label. */
  label: string;
  /** Dim annotation shown after the label (e.g. owner, 'default'). */
  hint?: string;
  /** Marks the currently-active entry (✓) and seeds the initial cursor. */
  current?: boolean;
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

interface SelectListProps {
  title: string;
  items: SelectItem[];
  onSelect: (value: string) => void;
  onCancel: () => void;
  /** Max item rows rendered at once; the list windows around the cursor. */
  maxVisible?: number;
}

/**
 * SelectList — arrow-key picker rendered in the dynamic region (v0.7.10).
 *
 * Used by `/provider` and `/model` (no args) to make providers and models
 * selectable instead of typed. The App swaps it in for the InputBar while
 * open, so ink-text-input never competes for keystrokes. ↑/↓ move (with
 * wrap-around), enter selects, esc cancels. Long lists scroll inside a
 * `maxVisible` window so the dynamic region stays under a screen.
 */
export function SelectList({
  title,
  items,
  onSelect,
  onCancel,
  maxVisible = 8,
}: SelectListProps): React.ReactElement {
  const firstCurrent = items.findIndex((i) => i.current);
  const [index, setIndex] = useState(firstCurrent === -1 ? 0 : firstCurrent);
  const { isRawModeSupported } = useStdin();

  useInput(
    (_input, key) => {
      if (key.upArrow) {
        setIndex((i) => (i - 1 + items.length) % items.length);
      } else if (key.downArrow) {
        setIndex((i) => (i + 1) % items.length);
      } else if (key.return) {
        const item = items[index];
        if (item) onSelect(item.value);
      } else if (key.escape) {
        onCancel();
      }
    },
    { isActive: isRawModeSupported === true },
  );

  const start = windowStart(index, items.length, maxVisible);
  const visible = items.slice(start, start + maxVisible);
  const below = items.length - (start + visible.length);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">{title}</Text>
      {start > 0 && <Text dimColor>  ↑ {start} more</Text>}
      {visible.map((item, i) => {
        const selected = start + i === index;
        return (
          <Text key={item.value} wrap="truncate" color={selected ? 'cyan' : undefined}>
            {selected ? '❯ ' : '  '}
            <Text bold={selected}>{item.label}</Text>
            {item.current ? <Text color="green"> ✓</Text> : null}
            {item.hint ? <Text dimColor>  {item.hint}</Text> : null}
          </Text>
        );
      })}
      {below > 0 && <Text dimColor>  ↓ {below} more</Text>}
      <Text dimColor>↑/↓ move · enter select · esc cancel</Text>
    </Box>
  );
}
