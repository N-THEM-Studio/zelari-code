import React from 'react';
import { Box, Text } from 'ink';
import { formatDuration } from '../utils/duration.js';

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
 * StatusBar — single one-line status bar. v0.7.9: rendered BELOW the input
 * box (the "top bar" position above it is gone), and the token/cost fields
 * are replaced by an execution timer: `⏱ 12s` while a run is in flight,
 * `last 34s` after it completes.
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
    <Box paddingX={1}>
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
      <Text dimColor> · </Text>
      <Text dimColor>session {sessionId}</Text>
      {cwd ? (
        <>
          <Text dimColor> · </Text>
          <Text color="blue">{cwd}</Text>
        </>
      ) : null}
      {busy && elapsedMs !== null ? (
        <>
          <Text dimColor> · </Text>
          <Text color="yellow">⏱ {formatDuration(elapsedMs)}</Text>
        </>
      ) : lastMs !== null ? (
        <>
          <Text dimColor> · </Text>
          <Text dimColor>last {formatDuration(lastMs)}</Text>
        </>
      ) : null}
      {queueCount > 0 ? (
        <>
          <Text dimColor> · </Text>
          <Text color="magenta">queue {queueCount}</Text>
        </>
      ) : null}
    </Box>
  );
}
