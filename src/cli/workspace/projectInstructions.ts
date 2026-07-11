/**
 * Load project instruction files (AGENTS.md / CLAUDE.md) for system prompt
 * injection — coding-CLI baseline (Cursor / Claude Code style).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Prefer order: Zelari Agents.md family first, then Claude-compatible. */
const CANDIDATES = [
  'AGENTS.md',
  'Agents.md',
  'agents.md',
  'CLAUDE.md',
  'Claude.md',
  'claude.md',
] as const;

/** Soft cap so huge AGENTS.md files don't blow context. */
const MAX_CHARS = 8_000;

export interface ProjectInstructions {
  /** Absolute path of the file that was loaded, if any. */
  path: string | null;
  /** Body text (trimmed, possibly truncated). */
  content: string;
  truncated: boolean;
}

/**
 * Find and load the first matching instruction file under `projectRoot`.
 */
export function loadProjectInstructions(
  projectRoot: string = process.cwd(),
  maxChars: number = MAX_CHARS,
): ProjectInstructions {
  for (const name of CANDIDATES) {
    const full = join(projectRoot, name);
    if (!existsSync(full)) continue;
    try {
      let raw = readFileSync(full, 'utf8');
      raw = raw.replace(/\r\n/g, '\n').trim();
      if (!raw) continue;
      if (raw.length <= maxChars) {
        return { path: full, content: raw, truncated: false };
      }
      return {
        path: full,
        content:
          raw.slice(0, maxChars) +
          `\n\n… [truncated; full file is ${raw.length} chars at ${name}]`,
        truncated: true,
      };
    } catch {
      continue;
    }
  }
  return { path: null, content: '', truncated: false };
}
