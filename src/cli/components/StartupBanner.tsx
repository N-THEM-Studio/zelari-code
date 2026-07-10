/**
 * StartupBanner — one-shot brand header for the Static scrollback region.
 *
 * Uses Ink flex layout (two columns) instead of space-padding a single string.
 * Space-padded banners collapse in many terminals / Ink Text and leave a
 * mangled logo on the left (see Windows repro 2026-07-10).
 */
import React from 'react';
import { Box, Text } from 'ink';
import { BRAND_LOGO_ASCII, BRAND_LOGO_COMPACT } from './brandArt.js';

export interface StartupBannerProps {
  version: string;
  providerId: string;
  model: string;
  cwd: string;
  columns: number;
  rows: number;
}

export function StartupBanner({
  version,
  providerId,
  model,
  cwd,
  columns,
  rows,
}: StartupBannerProps): React.ReactElement {
  const compact = columns < 72 || rows < 20;
  const logo = (compact ? BRAND_LOGO_COMPACT : BRAND_LOGO_ASCII).split('\n');

  const leftLines = [
    `zelari-code v${version} — ${providerId}/${model}`,
    `cwd: ${cwd}`,
    `/help · /plan · /build · /view-plan · shift+tab mode`,
  ];

  return (
    <Box flexDirection="row" justifyContent="space-between" marginBottom={1} width="100%">
      <Box flexDirection="column" flexGrow={1} marginRight={2}>
        {leftLines.map((line, i) => (
          <Text key={i} color={i === 0 ? 'cyan' : undefined} dimColor={i > 0}>
            {line}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" flexShrink={0} alignItems="flex-end">
        {logo.map((line, i) => (
          <Text key={i} color="cyan">
            {line}
          </Text>
        ))}
        <Text bold color="white">
          ZELARI CODE
        </Text>
        <Text dimColor>v{version}</Text>
      </Box>
    </Box>
  );
}
