import React from 'react';
import { Box, Text } from 'ink';
import { formatCost, formatTokens } from '../modelPricing.js';

interface StatusBarProps {
  model: string;
  provider: string;
  sessionId: string;
  sessionActive: boolean;
  totalTokens?: number;
  totalCostUsd?: number;
  queueCount?: number;
  busy?: boolean;
}

/**
 * StatusBar — single one-line status bar replacing the persistent v0.6
 * `Header`. It lives in the dynamic region (repainted by Ink) and condenses:
 * provider · model · session · tokens · cost · queue · busy.
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
  totalTokens,
  totalCostUsd,
  queueCount = 0,
  busy = false,
}: StatusBarProps): React.ReactElement {
  const hasCost = typeof totalCostUsd === 'number' && totalCostUsd > 0;
  const costStr = hasCost ? formatCost(totalCostUsd) : '$0.0000';
  const tokStr = formatTokens(totalTokens ?? 0);
  return (
    <Box paddingX={1}>
      <Text color={sessionActive ? 'green' : 'gray'}>
        {sessionActive ? '●' : '○'}
      </Text>
      <Text dimColor> </Text>
      <Text bold color="cyan">{provider}</Text>
      <Text dimColor> · </Text>
      <Text>{model}</Text>
      <Text dimColor> · </Text>
      <Text dimColor>session {sessionId}</Text>
      <Text dimColor> · </Text>
      <Text color="gray">{tokStr} tok</Text>
      <Text dimColor> · </Text>
      <Text color={hasCost ? 'yellow' : 'gray'}>{costStr}</Text>
      {queueCount > 0 ? (
        <>
          <Text dimColor> · </Text>
          <Text color="magenta">queue {queueCount}</Text>
        </>
      ) : null}
      {busy ? (
        <>
          <Text dimColor> · </Text>
          <Text color="yellow">working</Text>
        </>
      ) : null}
    </Box>
  );
}
