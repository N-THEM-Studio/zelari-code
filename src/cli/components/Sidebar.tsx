import React from 'react';
import { Box, Text } from 'ink';
import type { GitChanges, GitFileChange } from '../hooks/useGitChanges.js';

/**
 * The N-THEM emblem as Braille art (v0.7.9 / restored exact v1.6.0 glyph).
 * Each Braille cell packs a 2×4 dot grid, denser than ASCII splash art.
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
/** The Braille emblem is added only when the terminal is at least this tall (v1.6.0). */
const EMBLEM_MIN_ROWS = 1; // always show Braille when sidebar is open (v1.6.0 glyph; was 26)
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

interface SidebarProps {
  version: string;
  changes: GitChanges;
  rows: number;
}

/**
 * Sidebar — right-hand column of the dynamic region (exact v1.6.0 branding).
 *
 * Shows the Braille N-THEM emblem (on tall terminals), the wordmark + version,
 * and the current git working-tree changes with +added/-removed line counts.
 */
export function Sidebar({ version, changes, rows }: SidebarProps): React.ReactElement {
  const showEmblem = rows >= EMBLEM_MIN_ROWS;
  const maxFiles = rows >= EMBLEM_MIN_ROWS + 8 ? MAX_FILES_TALL : MAX_FILES_SHORT;
  const visible = changes.files.slice(0, maxFiles);
  const hidden = changes.files.length - visible.length;
  // Width available for the path inside the box: total − border(2) − padding(2)
  // − the " +NNN -NNN" tail (~11 chars).
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
      {showEmblem && (
        <Box justifyContent="center">
          <Text color="cyan">{EMBLEM_BRAILLE}</Text>
        </Box>
      )}
      <Box justifyContent="center">
        <Text bold color="white">ZELARI CODE</Text>
      </Box>
      <Box justifyContent="center">
        <Text dimColor>
          v{version}
          {changes.branch ? ` · ${truncatePath(changes.branch, 12)}` : ''}
        </Text>
      </Box>
      <Text dimColor>{'─'.repeat(innerWidth)}</Text>
      {!changes.isRepo ? (
        <Text dimColor italic>not a git repo</Text>
      ) : changes.files.length === 0 ? (
        <Text dimColor italic>no changes</Text>
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

function FileRow({ file, pathWidth }: { file: GitFileChange; pathWidth: number }): React.ReactElement {
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
