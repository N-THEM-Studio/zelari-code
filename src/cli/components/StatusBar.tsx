import React from 'react';
import { Box, Text } from 'ink';
import { formatDuration } from '../utils/duration.js';
import { Spinner } from './Spinner.js';

export type ChatMode = 'agent' | 'council';

interface StatusBarProps {
  model: string;
  provider: string;
  sessionId: string;
  sessionActive: boolean;
  queueCount?: number;
  busy?: boolean;
  /** Dispatch mode for free-form prompts — toggled with shift+tab (v0.7.9). */
  mode?: ChatMode;
  /** Current working directory, already shortened by the caller. */
  cwd?: string;
  /** Milliseconds elapsed in the current run; null while idle (v0.7.9). */
  elapsedMs?: number | null;
  /** Duration of the last completed run; null before the first run. */
  lastMs?: number | null;
}

/**
 * StatusBar — single one-line status bar rendered below the input box.
 *
 * v0.7.10: extended to the full terminal width. Two groups justified with
 * space-between: identity on the left (mode · provider · model · cwd) and
 * run state on the right (spinner+timer / last, queue, session). Both groups
 * truncate instead of wrapping, so the bar is always exactly one row — the
 * old layout wrapped on narrow terminals, squashing the dynamic region.
 *
 * Why one line: the static-scrollback model (v0.7.0) needs the dynamic
 * region as short as possible. A single status line + the input bar + the
 * streaming tail is always well under a screen, so no full repaint.
 */
export function StatusBar({
  model,
  provider,
  sessionId,
  sessionActive,
  queueCount = 0,
  busy = false,
  mode = 'agent',
  cwd,
  elapsedMs = null,
  lastMs = null,
}: StatusBarProps): React.ReactElement {
  return (
    <Box paddingX={1} width="100%" justifyContent="space-between" gap={2}>
      {/* Left group shrinks (truncates) before the right one on narrow panes. */}
      <Box flexShrink={2}>
      <Text wrap="truncate">
        <Text color={sessionActive ? 'green' : 'gray'}>
          {sessionActive ? '●' : '○'}
        </Text>
        <Text dimColor> </Text>
        <Text bold color={mode === 'council' ? 'magenta' : 'cyan'}>
          {mode === 'council' ? '⛬ council' : '⏵ agent'}
        </Text>
        <Text dimColor> (shift+tab)</Text>
        <Text dimColor> · </Text>
        <Text bold color="cyan">{provider}</Text>
        <Text dimColor> · </Text>
        <Text>{model}</Text>
        {cwd ? (
          <>
            <Text dimColor> · </Text>
            <Text color="blue">{cwd}</Text>
          </>
        ) : null}
      </Text>
      </Box>
      <Box flexShrink={1}>
      <Text wrap="truncate">
        {busy && elapsedMs !== null ? (
          <>
            <Spinner color="yellow" />
            <Text color="yellow"> {formatDuration(elapsedMs)}</Text>
            <Text dimColor> · </Text>
          </>
        ) : lastMs !== null ? (
          <>
            <Text dimColor>last {formatDuration(lastMs)}</Text>
            <Text dimColor> · </Text>
          </>
        ) : null}
        {queueCount > 0 ? (
          <>
            <Text color="magenta">queue {queueCount}</Text>
            <Text dimColor> · </Text>
          </>
        ) : null}
        <Text dimColor>session {sessionId}</Text>
      </Text>
      </Box>
    </Box>
  );
}
