import React from 'react';
import { Box, Text } from 'ink';

interface SidebarProps {
  skillList: string;
  sessionCount: number;
  isSlashMode: boolean;
  height: number;
}

/**
 * Sidebar showing: formatted skill list (from formatSkillList), session count,
 * and an indicator when the user is typing a slash command.
 */
export function Sidebar({ skillList, sessionCount, isSlashMode, height }: SidebarProps): React.ReactElement {
  const lines = skillList.split('\n');
  const headerLines = 3 + (isSlashMode ? 1 : 0);
  const maxSkillLines = Math.max(2, height - headerLines - 3); // 3 for border + padding
  const visibleSkillLines = lines.slice(0, maxSkillLines);
  const showTruncatedIndicator = lines.length > maxSkillLines;
  if (showTruncatedIndicator) {
    visibleSkillLines.push('  ... (more in /skills)');
  }

  return (
    <Box flexDirection="column" width={40} height={height} borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold color="cyan">Skills &amp; sessions</Text>
      <Text dimColor>Sessions: {sessionCount}</Text>
      {isSlashMode && <Text color="yellow">⌨ slash command mode</Text>}
      <Box marginTop={1} flexDirection="column">
        {visibleSkillLines.map((line, idx) => (
          <Text key={idx}>{line}</Text>
        ))}
      </Box>
    </Box>
  );
}
