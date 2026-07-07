import { homedir } from 'node:os';
import path from 'node:path';

/**
 * shortenCwd — compact a directory path for one-line UI surfaces
 * (StatusBar, banner).
 *
 * - The home directory prefix collapses to `~`.
 * - Paths longer than `maxLen` keep the tail (the informative part) with a
 *   leading `…`.
 */
export function shortenCwd(p: string, maxLen = 40, home: string = homedir()): string {
  let out = p;
  if (
    home &&
    (out === home || out.startsWith(`${home}\\`) || out.startsWith(`${home}/`))
  ) {
    out = `~${out.slice(home.length)}`;
  }
  if (out.length <= maxLen) return out;
  return `…${out.slice(-(maxLen - 1))}`;
}

/**
 * relativePosix — relativize a path against a root and normalize to `/`.
 *
 * Why: `path.relative()` on win32 joins segments with backslashes. Every
 * agent-facing surface (LSP tool results, diagnostic output) wants forward
 * slashes — they match `file://` URIs, JSON, markdown, and every other path
 * already shown to the model. Before this helper, two near-identical private
 * functions (`relPath` in lsp/tools.ts, `relative` in diagnostics/engine.ts)
 * called `path.relative` with zero normalization, producing `src\a.ts` on
 * Windows where the rest of the output stream uses `src/a.ts`.
 *
 * Semantics:
 *   - Returns the relative path when `to` is inside `from`.
 *   - Returns `to` unchanged when it escapes the root (`..` traversal) or the
 *     relativization fails, so absolute paths outside the project are shown
 *     as-is rather than as a misleading `..\..\elsewhere`.
 *   - Output always uses `/` regardless of platform separator.
 *
 * Not for: filesystem I/O (platform-native separators matter there) or URI
 * construction (see lsp/protocol.ts `pathToUri`, which also percent-encodes).
 *
 * @param from  Anchor directory (typically the project root).
 * @param to    Target file or directory (absolute, or already relative).
 * @returns POSIX-style relative path, or `to` if it can't be relativized.
 */
export function relativePosix(from: string, to: string): string {
  try {
    const rel = path.relative(from, to);
    if (!rel || rel.startsWith('..')) return to;
    return rel.split(path.sep).join('/');
  } catch {
    return to;
  }
}

