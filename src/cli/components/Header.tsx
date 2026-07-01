import React from 'react';
import { Box, Text } from 'ink';
import { formatCost, formatTokens } from '../modelPricing.js';

interface HeaderProps {
  model: string;
  provider: string;
  skillCount: number;
  sessionActive: boolean;
  sessionId: string;
  /** Estimated total tokens used so far this session (Task B.1.1). */
  totalTokens?: number;
  /** Estimated total cost in USD so far this session. */
  totalCostUsd?: number;
}

/**
 * Header bar — model, provider, skill count, session id, cost, tokens.
 *
 * Performance: wrapped in React.memo with a custom comparator. The Header
 * re-renders only when one of its primitive props actually changes. This is
 * critical because the parent App re-renders on EVERY streaming token delta
 * (≈20-50/sec during LLM response); without memo the Header would redraw its
 * border 50×/sec, causing visible flicker on the top edge of the terminal.
 */
function HeaderImpl({ model, provider, skillCount, sessionActive, sessionId, totalTokens, totalCostUsd }: HeaderProps): React.ReactElement {
  const hasCost = typeof totalCostUsd === 'number' && totalCostUsd > 0;
  const costStr = hasCost ? formatCost(totalCostUsd) : '$0.0000';
  const tokStr = formatTokens(totalTokens ?? 0);
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="row">
      <Text bold color="cyan">zelari-code</Text>
      <Text dimColor> · </Text>
      <Text>{model}</Text>
      <Text dimColor> · </Text>
      <Text>{provider}</Text>
      <Text dimColor> · </Text>
      <Text>{skillCount} skills</Text>
      <Text dimColor> · </Text>
      <Text color={sessionActive ? 'green' : 'gray'}>
        {sessionActive ? '● active' : '○ idle'}
      </Text>
      <Text dimColor> · </Text>
      <Text dimColor>session {sessionId}</Text>
      <Text dimColor> · </Text>
      <Text color={hasCost ? 'yellow' : 'gray'}>{costStr}</Text>
      <Text dimColor> · </Text>
      <Text color="gray">{tokStr} tok</Text>
    </Box>
  );
}

export const Header = React.memo(HeaderImpl, (prev, next) => {
  // Custom shallow-equal for primitives — avoids Object.is on every render.
  return (
    prev.model === next.model &&
    prev.provider === next.provider &&
    prev.skillCount === next.skillCount &&
    prev.sessionActive === next.sessionActive &&
    prev.sessionId === next.sessionId &&
    prev.totalTokens === next.totalTokens &&
    prev.totalCostUsd === next.totalCostUsd
  );
});