/**
 * gitOps — git-backed operations for slash commands.
 *
 * Exposes:
 *   - `getWorkingDiff(opts)` → returns the output of `git diff` (and optionally
 *     `git diff --cached`) as a string. Read-only, safe.
 *   - `undoWorkingChanges(opts)` → reverts working-tree modifications via
 *     `git checkout -- .` and `git reset HEAD` for staged changes.
 *     Destructive — callers should require an explicit `--yes` flag.
 *
 * Pure Node child_process — no Electron deps, browser-importable for tests.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export interface DiffOptions {
  /** Include staged changes (`git diff --cached`). Default false. */
  staged?: boolean;
  /** Working directory. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Hard cap on diff length returned (chars). Default 50_000. */
  maxChars?: number;
}

export interface DiffResult {
  /** Combined diff text. */
  diff: string;
  /** True if the diff was truncated due to maxChars. */
  truncated: boolean;
  /** True if there are no changes at all. */
  empty: boolean;
}

export interface UndoOptions {
  /** Working directory. Defaults to `process.cwd()`. */
  cwd?: string;
  /** If true, also unstage everything (`git reset HEAD`). Default true. */
  unstage?: boolean;
}

export interface UndoResult {
  /** Reverted file paths (post-checkout). */
  reverted: string[];
  /** Unstaged file paths (post-reset). */
  unstaged: string[];
  /** Human-readable summary. */
  summary: string;
}

/**
 * Best-effort: run `git -C <cwd> <args>` and return stdout. Returns null on
 * error (no git, not a repo, etc.). Never throws.
 */
async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

/** True if the working directory is inside a git working tree. */
export async function isGitRepo(cwd: string = process.cwd()): Promise<boolean> {
  const out = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  return out?.trim() === 'true';
}

/**
 * Read the working-tree diff. Combines `git diff` (unstaged) and, when
 * `staged: true`, `git diff --cached` (staged).
 */
export async function getWorkingDiff(opts: DiffOptions = {}): Promise<DiffResult> {
  const cwd = opts.cwd ?? process.cwd();
  const maxChars = opts.maxChars ?? 50_000;
  const unstaged = (await git(cwd, ['diff'])) ?? '';
  const staged = opts.staged
    ? ((await git(cwd, ['diff', '--cached'])) ?? '')
    : '';
  const combined = [staged, unstaged].filter((s) => s.length > 0).join('\n');
  if (combined.length === 0) {
    return { diff: '', truncated: false, empty: true };
  }
  if (combined.length > maxChars) {
    return { diff: combined.slice(0, maxChars), truncated: true, empty: false };
  }
  return { diff: combined, truncated: false, empty: false };
}

/**
 * Revert working-tree changes. Discards:
 *   - All unstaged modifications (`git checkout -- .`)
 *   - All untracked files are NOT touched (would be too dangerous — use a
 *     separate `git clean` command for that, intentionally not exposed here).
 *   - Optionally unstages everything (`git reset HEAD`).
 *
 * Returns the list of files that were touched, so callers can show feedback.
 */
export async function undoWorkingChanges(opts: UndoOptions = {}): Promise<UndoResult> {
  const cwd = opts.cwd ?? process.cwd();
  const unstage = opts.unstage !== false; // default true

  // Snapshot the list of modified + staged files BEFORE the revert so we
  // can report what changed. We exclude untracked ('??') and ignored ('!!')
  // entries — undoing those would require `git clean`, which is intentionally
  // NOT exposed here.
  const statusBefore = (await git(cwd, ['status', '--porcelain'])) ?? '';
  const modified = statusBefore
    .split('\n')
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith('??') && !line.startsWith('!!'))
    .map((line) => line.slice(3).trim());

  // 1. `git checkout -- .` — revert unstaged modifications.
  await git(cwd, ['checkout', '--', '.']);

  // 2. Optionally `git reset HEAD` — unstage everything.
  if (unstage) {
    await git(cwd, ['reset', 'HEAD', '--', '.']);
  }

  return {
    reverted: modified,
    unstaged: unstage ? modified : [],
    summary: `Reverted ${modified.length} file(s)${unstage ? ' (also unstaged)' : ''}.`,
  };
}

/** Resolve the project root (the directory of this module's package.json) for convenience. */
export function defaultProjectRoot(): string {
  // electron/cli/gitOps.ts → 3 levels up = project root.
  return path.resolve(__dirname, '..', '..', '..');
}