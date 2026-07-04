import { homedir } from 'node:os';

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
