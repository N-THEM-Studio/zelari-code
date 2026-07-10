import React from 'react';
import { Box, Text } from 'ink';
import type { GitChanges, GitFileChange } from '../hooks/useGitChanges.js';
import { BRAND_LOGO_COMPACT } from './brandArt.js';

/**
 * Dense Braille emblem (v1.6.0). Shown when the terminal is tall enough
 * AND when ZELARI_ASCII_LOGO is not set. Many Windows fonts render Braille
 * as blank — ASCII compact is the reliable default on short panes.
 */
const EMBLEM_BRAILLE = `⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣴⣿⣷⣆⡀
⠀⠀⠀⠀⠀⠀⠀⢀⣶⣿⣿⣿⣿⣿⣿⣦⡀
⠀⠀⠀⠀⠀⠀⣰⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦
⠀⠀⠀⠀⢠⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⡄
⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⠙⠻⣿⣿⣿⣿⣿⣿⠆
⠀⠀⠀⠀⣈⣿⣿⣿⣿⣿⣿⣿⠀⣷⣬⡛⢿⣿⣟⣁
⠀⢀⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⠀⡿⢿⡿⢃⣈⣻⣿⣿⣶
⠀⣼⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣠⣴⣆⠻⠎⢿⣿⣿⣿⣿⣧
⣰⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇`;

/** Column width of the sidebar (border + padding included). */
export const SIDEBAR_WIDTH = 28;
/** Sidebar only renders on terminals at least this wide. */
export const SIDEBAR_MIN_COLUMNS = 96;
/**
 * Hysteresis floor: once visible, stay visible until width drops below this
 * (resize thrash protection, v1.8.1+).
 */
export const SIDEBAR_HIDE_COLUMNS = 88;
/** Min rows to show; hide below this. */
export const SIDEBAR_MIN_ROWS = 16;
export const SIDEBAR_HIDE_ROWS = 14;
/** Prefer Braille only on tall terminals (matches v1.6.0 density). */
const BRAILLE_MIN_ROWS = 28;
/** Max file rows before collapsing to "+N more". */
const MAX_FILES_SHORT = 6;
const MAX_FILES_TALL = 10;

/**
 * Pure helper: should the sidebar render at all? It lives in the dynamic
 * region (Ink repaints it), so it must never make that region taller than
 * the terminal — narrow or tiny panes skip it entirely.
 */
export function shouldShowSidebar(columns: number, rows: number): boolean {
  return columns >= SIDEBAR_MIN_COLUMNS && rows >= SIDEBAR_MIN_ROWS;
}

/**
 * Hysteresis visibility: once shown, requires a clearer "leave" signal
 * before hiding — stops resize-edge flicker.
 */
export function sidebarVisibility(
  columns: number,
  rows: number,
  currentlyVisible: boolean,
): boolean {
  if (currentlyVisible) {
    return columns >= SIDEBAR_HIDE_COLUMNS && rows >= SIDEBAR_HIDE_ROWS;
  }
  return shouldShowSidebar(columns, rows);
}

/** Truncate a repo-relative path to `max` chars keeping the tail (filename). */
export function truncatePath(p: string, max: number): string {
  if (p.length <= max) return p;
  return `…${p.slice(-(max - 1))}`;
}

function preferAsciiLogo(): boolean {
  // Explicit override, or default to ASCII on Windows where Braille often
  // renders as empty cells in default console fonts.
  if (process.env.ZELARI_ASCII_LOGO === '1') return true;
  if (process.env.ZELARI_ASCII_LOGO === '0') return false;
  return process.platform === 'win32';
}

interface SidebarProps {
  version: string;
  changes: GitChanges;
  rows: number;
}

/**
 * Sidebar — right-hand column of the dynamic region.
 *
 * Always shows a visible emblem (ASCII compact by default on Windows /
 * short terminals; Braille on tall non-Windows when not forced to ASCII),
 * the wordmark + version, and git working-tree changes.
 */
export function Sidebar({ version, changes, rows }: SidebarProps): React.ReactElement {
  const useBraille = !preferAsciiLogo() && rows >= BRAILLE_MIN_ROWS;
  const logoLines = useBraille
    ? EMBLEM_BRAILLE.split('\n')
    : BRAND_LOGO_COMPACT.split('\n');
  const maxFiles = rows >= BRAILLE_MIN_ROWS + 8 ? MAX_FILES_TALL : MAX_FILES_SHORT;
  const visible = changes.files.slice(0, maxFiles);
  const hidden = changes.files.length - visible.length;
  const innerWidth = SIDEBAR_WIDTH - 4;

  return (
    <Box
      flexDirection="column"
      width={SIDEBAR_WIDTH}
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      flexShrink={0}
    >
      <Box flexDirection="column" alignItems="center">
        {logoLines.map((line, i) => (
          <Text key={i} color="cyan">
            {line}
          </Text>
        ))}
      </Box>
      <Box justifyContent="center">
        <Text bold color="white">
          ZELARI CODE
        </Text>
      </Box>
      <Box justifyContent="center">
        <Text dimColor>
          v{version}
          {changes.branch ? ` · ${truncatePath(changes.branch, 12)}` : ''}
        </Text>
      </Box>
      <Text dimColor>{'─'.repeat(innerWidth)}</Text>
      {!changes.isRepo ? (
        <Text dimColor italic>
          not a git repo
        </Text>
      ) : changes.files.length === 0 ? (
        <Text dimColor italic>
          no changes
        </Text>
      ) : (
        <>
          <Text dimColor>changes ({changes.files.length})</Text>
          {visible.map((f) => (
            <FileRow key={f.path} file={f} pathWidth={innerWidth - 10} />
          ))}
          {hidden > 0 && <Text dimColor>  +{hidden} more…</Text>}
        </>
      )}
    </Box>
  );
}

function FileRow({
  file,
  pathWidth,
}: {
  file: GitFileChange;
  pathWidth: number;
}): React.ReactElement {
  const name = truncatePath(file.path, Math.max(6, pathWidth));
  return (
    <Box>
      <Text wrap="truncate">
        <Text color={file.untracked ? 'yellow' : 'white'}>{name}</Text>
        {file.untracked ? (
          <Text color="yellow"> new</Text>
        ) : (
          <>
            <Text color="green"> +{file.added ?? '·'}</Text>
            <Text color="red"> -{file.removed ?? '·'}</Text>
          </>
        )}
      </Text>
    </Box>
  );
}
