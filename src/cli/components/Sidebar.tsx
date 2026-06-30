import React from 'react';
import { Box, Text } from 'ink';

interface SidebarProps {
  skillList: string;
  sessionCount: number;
  isSlashMode: boolean;
}

/**
 * Sidebar showing: formatted skill list (from formatSkillList), session count,
 * and an indicator when the user is typing a slash command.
 */
export function Sidebar({ skillList, sessionCount, isSlashMode }: SidebarProps): React.ReactElement {
  return (
    <Box flexDirection="column" width={40} borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold color="cyan">Skills &amp; sessions</Text>
      <Text dimColor>Sessions: {sessionCount}</Text>
      {isSlashMode && <Text color="yellow">⌨ slash command mode</Text>}
      <Box marginTop={1} flexDirection="column">
        <Text>{skillList}</Text>
      </Box>
    </Box>
  );
}
