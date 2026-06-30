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

export function Header({ model, provider, skillCount, sessionActive, sessionId, totalTokens, totalCostUsd }: HeaderProps): React.ReactElement {
  const hasCost = typeof totalCostUsd === 'number' && totalCostUsd > 0;
  const costStr = hasCost ? formatCost(totalCostUsd) : '$0.0000';
  const tokStr = formatTokens(totalTokens ?? 0);
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="row">
      <Text bold color="cyan">anathema-coder</Text>
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