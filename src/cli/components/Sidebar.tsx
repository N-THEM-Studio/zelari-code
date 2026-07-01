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
 *
 * Performance: React.memo with custom comparator. sessionCount changes only on
 * message append, not on every streaming delta — but React.memo's default
 * shallow equal still triggers re-render because the parent passes a fresh
 * primitive int each render. The custom comparator avoids that. Sidebar also
 * rebuilds its visibleSkills slice via useMemo to avoid re-splitting on every
 * parent render.
 */
function SidebarImpl({ skillList, sessionCount, isSlashMode, height }: SidebarProps): React.ReactElement {
  // Truncate visible skills list to fit the available height. useMemo so we
  // don't re-split on every render (e.g. during streaming token deltas).
  const { visibleLines, truncated } = React.useMemo(() => {
    const lines = skillList.split('\n');
    const headerLines = 3 + (isSlashMode ? 1 : 0);
    const maxSkillLines = Math.max(2, height - headerLines - 3); // 3 for border + padding
    return {
      visibleLines: lines.slice(0, maxSkillLines),
      truncated: lines.length > maxSkillLines,
    };
  }, [skillList, isSlashMode, height]);

  return (
    <Box flexDirection="column" width={40} height={height} borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold color="cyan">Skills &amp; sessions</Text>
      <Text dimColor>Sessions: {sessionCount}</Text>
      {isSlashMode && <Text color="yellow">⌨ slash command mode</Text>}
      <Box marginTop={1} flexDirection="column">
        {visibleLines.map((line, idx) => (
          // key={idx} is OK here: order is stable, content is what changes.
          <Text key={idx}>{line}</Text>
        ))}
        {truncated && <Text dimColor>  ... (more in /skills)</Text>}
      </Box>
    </Box>
  );
}

export const Sidebar = React.memo(SidebarImpl, (prev, next) => {
  return (
    prev.skillList === next.skillList &&
    prev.sessionCount === next.sessionCount &&
    prev.isSlashMode === next.isSlashMode &&
    prev.height === next.height
  );
});
