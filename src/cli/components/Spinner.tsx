import React, { useEffect, useState } from 'react';
import { Text } from 'ink';
import { formatDuration } from '../utils/duration.js';

/** Braille spinner frames — one step every FRAME_MS. */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const FRAME_MS = 100;

/** Rotating activity verbs shown by <WorkingIndicator>, one every VERB_MS. */
const VERBS = ['thinking', 'working', 'reasoning', 'assembling'] as const;
const VERB_MS = 2500;
/** Trailing-dots animation period (…→ . → .. → ...). */
const DOTS_MS = 400;

/**
 * Shared ticker hook: increments every FRAME_MS while mounted. Both animated
 * components derive spinner frame / verb / dots from the same counter so a
 * single interval drives everything.
 */
function useTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), FRAME_MS);
    return () => clearInterval(id);
  }, []);
  return tick;
}

/** Minimal animated braille spinner (single glyph, no label). */
export function Spinner({ color = 'yellow' }: { color?: string }): React.ReactElement {
  const tick = useTick();
  return <Text color={color}>{FRAMES[tick % FRAMES.length]}</Text>;
}

/**
 * WorkingIndicator — replaces the static `⋯ working…` line (v0.7.10).
 * Animated spinner + a verb that rotates every ~2.5s + trailing dots, plus
 * the elapsed run time when the caller provides it. The motion makes it
 * obvious the run is alive even before the first streamed token arrives.
 */
export function WorkingIndicator({
  elapsedMs = null,
}: {
  elapsedMs?: number | null;
}): React.ReactElement {
  const tick = useTick();
  const frame = FRAMES[tick % FRAMES.length];
  const verb = VERBS[Math.floor((tick * FRAME_MS) / VERB_MS) % VERBS.length];
  const dots = '.'.repeat(1 + (Math.floor((tick * FRAME_MS) / DOTS_MS) % 3));
  return (
    <Text color="yellow">
      {frame} {verb}{dots}
      {typeof elapsedMs === 'number' ? (
        <Text dimColor> ({formatDuration(elapsedMs)})</Text>
      ) : null}
    </Text>
  );
}
