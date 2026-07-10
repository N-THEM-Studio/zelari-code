import React from 'react';
import { Box, Text } from 'ink';
import type { GitChanges, GitFileChange } from '../hooks/useGitChanges.js';

/** Column width of the sidebar (border + padding included). */
export const SIDEBAR_WIDTH = 28;
/** Sidebar only renders on terminals at least this wide. */
export const SIDEBAR_MIN_COLUMNS = 96;
/**
 * Hysteresis floor: once visible, stay visible until width drops below this.
 * Prevents show/hide thrash while the user drags the window across 96 cols
 * (each toggle reflows the dynamic region and can trash Static scrollback).
 */
export const SIDEBAR_HIDE_COLUMNS = 88;
/** Min rows to show; hide below this. */
export const SIDEBAR_MIN_ROWS = 16;
export const SIDEBAR_HIDE_ROWS = 14;
/** Max file rows before collapsing to "+N more". */
const MAX_FILES_SHORT = 4;
const MAX_FILES_TALL = 8;
/** Absolute cap: sidebar chrome + files must stay short vs terminal rows. */
const SIDEBAR_CHROME_LINES = 4;

/**
 * Pure helper: should the sidebar render at all? It lives in the dynamic
 * region (Ink repaints it), so it must never make that region taller than
 * the terminal — narrow or tiny panes skip it entirely.
 *
 * Prefer {@link sidebarVisibility} when you have the previous visibility
 * (hysteresis). This boolean form is the strict "enter" threshold.
 */
export function shouldShowSidebar(columns: number, rows: number): boolean {
  return columns >= SIDEBAR_MIN_COLUMNS && rows >= SIDEBAR_MIN_ROWS;
}

/**
 * Hysteresis visibility: once shown, requires a clearer "leave" signal
 * (narrower / shorter) before hiding — stops resize-edge flicker.
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

/** How many file rows fit without blowing the dynamic-region budget. */
export function maxSidebarFiles(rows: number): number {
  // Reserve room for LiveRegion (~12) + input + status + chrome.
  const budget = Math.max(2, rows - 14 - SIDEBAR_CHROME_LINES);
  const cap = rows >= 28 ? MAX_FILES_TALL : MAX_FILES_SHORT;
  return Math.min(cap, budget);
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
  const maxFiles = maxSidebarFiles(rows);
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
      // Hard cap so a huge git status never makes Ink clear the whole screen.
      height={Math.min(rows - 8, SIDEBAR_CHROME_LINES + maxFiles + 2)}
      overflow="hidden"
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
