import React from 'react';
import { Box, Text } from 'ink';
import type { GitChanges, GitFileChange } from '../hooks/useGitChanges.js';

/** Column width of the sidebar (border + padding included). */
export const SIDEBAR_WIDTH = 28;
/** Sidebar only renders on terminals at least this wide. */
export const SIDEBAR_MIN_COLUMNS = 96;
/** Tall terminals get more file rows in the git-changes list. */
const EMBLEM_MIN_ROWS = 26;
/** Max file rows before collapsing to "+N more". */
const MAX_FILES_SHORT = 6;
const MAX_FILES_TALL = 10;

/**
 * Pure helper: should the sidebar render at all? It lives in the dynamic
 * region (Ink repaints it), so it must never make that region taller than
 * the terminal — narrow or tiny panes skip it entirely.
 */
export function shouldShowSidebar(columns: number, rows: number): boolean {
  return columns >= SIDEBAR_MIN_COLUMNS && rows >= 16;
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
 * Sidebar — right-hand column of the dynamic region (v0.7.9 / v1.8.0).
 *
 * v1.8.0: brand (logo + version) moved to StatusBar top-right strip. This
 * panel is now **git changes only** so it stays short in the dynamic region
 * (static-scrollback model cannot float a logo over the scrollback).
 */
export function Sidebar({ version, changes, rows }: SidebarProps): React.ReactElement {
  void version; // brand lives in StatusBar; keep prop for API stability
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
      <Box justifyContent="center">
        <Text dimColor>
          {changes.branch ? truncatePath(changes.branch, 18) : 'git'}
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
