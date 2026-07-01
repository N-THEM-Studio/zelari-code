import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * _walk — Shared directory walker used by list_files and grep_content.
 *
 * Walks a directory recursively up to {@link maxDepth} and yields
 * {@link FileEntry} objects (path relative to the walked directory + type).
 * Honors {@link exclude} glob patterns and skips unreadable subdirectories
 * silently. Honors {@link signal} for cancellation.
 *
 * Glob syntax (intentionally minimal — no external deps):
 *   - `*`  → any sequence of non-/ characters
 *   - `?`  → any single non-/ character
 *   - `[abc]` → char class
 *   - Everything else is a literal (special regex chars auto-escaped)
 *
 * @internal Exported for tests + sibling tools in `builtin/`.
 */

export interface FileEntry {
  /** Path relative to the listed directory. */
  name: string;
  /** 'file' | 'directory' | 'other' (symlink, socket, etc.). */
  type: 'file' | 'directory' | 'other';
}

const REGEX_ESCAPE = /[.+^${}()|[\]\\]/g;

function escapeRegex(p: string): string {
  return p.replace(REGEX_ESCAPE, '\\$&');
}

function globToRegex(glob: string): RegExp {
  // Convert glob pattern to anchored RegExp.
  // Semantics:
  //   - `*`        → any chars except `/` (one segment)
  //   - `**`       → any chars including `/` (zero or more segments)
  //   - `**/`      → zero or more dirs (must be followed by something or end)
  //   - `?`        → any single char except `/`
  //   - `[abc]`    → char class
  //   - everything else is literal (regex special chars auto-escaped)
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          // **/ → zero or more dirs. Skip both stars AND the slash.
          re += '(?:.*/)?';
          i += 2; // skip second * AND trailing /
        } else {
          // ** at end (or **<not-slash>) → match anything
          re += '.*';
          i++; // skip second *
        }
      } else {
        // single * → match within one segment
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      const end = glob.indexOf(']', i);
      if (end === -1) {
        re += escapeRegex(c);
      } else {
        re += glob.slice(i, end + 1);
        i = end;
      }
    } else {
      re += escapeRegex(c);
    }
  }
  return new RegExp('^' + re + '$');
}

export function matchesAny(name: string, patterns: string[]): boolean {
  for (const p of patterns) {
    const re = globToRegex(p);
    if (re.test(name)) return true;
  }
  return false;
}

export const DEFAULT_EXCLUDES = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.cache',
  '.zelari', // v3-W workspace storage (never inspect)
  '.venv',
  'coverage',
  '.nyc_output',
];

/**
 * Walk a directory tree, collecting file/dir entries.
 * Mutates {@link entries} in place (avoids large array allocations on deep trees).
 *
 * Depth semantics: depth=0 means "do NOT descend into subdirectories" (root
 * entries only). depth=N means "descend at most N levels below root".
 *
 * The root directory itself is NOT added as an entry.
 */
export async function walk(
  dir: string,
  baseRel: string,
  depth: number,
  maxDepth: number,
  exclude: string[],
  entries: FileEntry[],
  signal: AbortSignal | undefined,
): Promise<void> {
  if (depth > maxDepth) return;
  if (signal?.aborted) return;
  let dirents: import('node:fs').Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable subdirectory — skip silently
  }
  if (signal?.aborted) return;
  for (const dirent of dirents) {
    if (matchesAny(dirent.name, exclude)) continue;
    const rel = baseRel ? `${baseRel}/${dirent.name}` : dirent.name;
    const isDir = dirent.isDirectory();
    entries.push({
      name: rel,
      type: isDir ? 'directory' : dirent.isFile() ? 'file' : 'other',
    });
    if (isDir && depth < maxDepth) {
      await walk(path.join(dir, dirent.name), rel, depth + 1, maxDepth, exclude, entries, signal);
    }
  }
}

/**
 * Filter a flat list of FileEntry to those whose relative path matches at
 * least one of {@link include} globs (matched against forward-slash paths).
 */
export function filterByInclude(entries: FileEntry[], include: string[]): FileEntry[] {
  if (include.length === 0 || (include.length === 1 && include[0] === '*')) {
    return entries.filter(e => e.type === 'file');
  }
  const regexes = include.map(globToRegex);
  return entries.filter(e => {
    if (e.type !== 'file') return false;
    return regexes.some(re => re.test(e.name));
  });
}