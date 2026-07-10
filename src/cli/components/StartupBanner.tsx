/**
 * StartupBanner — clean one-shot header (v1.6.0 shape).
 *
 * No multi-column ASCII art here: the Braille emblem lives in the right
 * Sidebar. A dual-column %-glyph banner looked messy on Windows terminals
 * and competed with the sidebar brand.
 */
import React from 'react';
import { Box, Text } from 'ink';

export interface StartupBannerProps {
  version: string;
  providerId: string;
  model: string;
  cwd: string;
  /** kept for API stability; unused */
  columns?: number;
  rows?: number;
}

export function StartupBanner({
  version,
  providerId,
  model,
  cwd,
}: StartupBannerProps): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="cyan">
        zelari-code v{version} — {providerId}/{model}
      </Text>
      <Text dimColor>cwd: {cwd}</Text>
      <Text dimColor>
        /help · /plan · /build · /view-plan · shift+tab mode
      </Text>
    </Box>
  );
}
