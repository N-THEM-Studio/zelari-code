import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { typedOk, typedErr, type ToolDefinition } from '../toolTypes.js';
import {
  walk,
  filterByInclude,
  compileGlobs,
  matchesAnyCompiled,
  DEFAULT_EXCLUDES,
  type FileEntry,
} from './_walk.js';

/**
 * grep_content — Regex search across one file OR a directory tree.
 *
 * Two modes:
 *   1. Single-file: `path` is a regular file → search it.
 *   2. Recursive: `path` is a directory → walk it (respecting `include` /
 *      `exclude` globs and `maxDepth`) and search each matched file.
 *
 * Backward-compatible: existing callers passing a single-file `path`
 * keep the v0.3.x behavior unchanged.
 *
 * Glob syntax: `*`, `?`, `[abc]`, `**` (recursive). See _walk.ts.
 */

/**
 * Coerce a model-emitted string OR string[] into string[].
 * Models often pass `include: "index.html"` or `include: "*.ts"` instead of
 * `["index.html"]` — without coercion Zod rejects with
 * "expected array, received string" and the whole tool call fails (v1.8.1).
 *
 * Kept OUT of the Zod schema (no `.transform`) so `toJSONSchema` still works
 * for LLM function-calling definitions.
 */
export function coerceStringList(value: unknown, fallback: string[]): string[] {
  if (value === undefined || value === null) return fallback;
  if (Array.isArray(value)) {
    const cleaned = value.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
    return cleaned.length > 0 ? cleaned : fallback;
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return fallback;
    // Allow comma-separated globs: "*.ts,*.tsx"
    if (s.includes(',') && !s.includes('{')) {
      const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
      return parts.length > 0 ? parts : fallback;
    }
    return [s];
  }
  return fallback;
}

/** Accept string OR string[] so model-emitted bare strings pass validation. */
const stringOrStringArray = z.union([z.string(), z.array(z.string())]);

const GrepContentArgsSchema = z.object({
  /** File OR directory to search (relative to cwd or absolute). */
  path: z.string().min(1),
  /** Regex pattern (no flags — gm is hardcoded). */
  pattern: z.string().min(1),
  /** Context lines before/after each match. */
  contextLines: z.number().int().nonnegative().default(2),
  /** Max matches returned (total matches still counted). */
  maxMatches: z.number().int().positive().max(1000).default(50),
  /**
   * Glob pattern(s) to INCLUDE when path is a directory.
   * Accepts a string OR string[] (models often emit a bare string).
   * Default ['*'] = all files. Ignored when path is a file.
   */
  include: stringOrStringArray.optional().default(['*']),
  /**
   * Glob pattern(s) to EXCLUDE when path is a directory.
   * Accepts a string OR string[]. Defaults to common noise dirs.
   */
  exclude: stringOrStringArray.optional().default(DEFAULT_EXCLUDES),
  /** Max recursion depth when path is a directory (default 8). */
  maxDepth: z.number().int().positive().max(15).default(8),
});

export { GrepContentArgsSchema };

type GrepContentArgs = z.infer<typeof GrepContentArgsSchema>;

interface GrepMatch {
  /** File path (absolute). */
  file: string;
  /** Relative path (vs the searched directory or single file). */
  relPath: string;
  line: number;
  text: string;
  context: { before: string[]; after: string[] };
}

interface GrepResult {
  matches: GrepMatch[];
  totalMatches: number;
  truncated: boolean;
  /** Number of files actually searched (1 for single-file mode). */
  filesSearched: number;
  /** Total files in tree (for recursive mode; 1 for single-file). */
  filesInTree: number;
  /** Files seen by the walker BEFORE the include filter (recursive mode; 1 for single-file). */
  filesWalked: number;
  /** Effective include globs after coercion (echo — confirms silent repairs). */
  effectiveInclude: string[];
  /** Effective exclude globs after coercion. */
  effectiveExclude: string[];
  /**
   * Non-fatal diagnostics for the caller: empty include scope
   * (SEARCH_EMPTY_SCOPE sentinel), suspicious non-recursive glob,
   * coerced or deprecated input (DEPRECATED_INPUT sentinel).
   * Multiple diagnostics are joined with '; '.
   */
  warning?: string;
}

/** True when at least one include glob uses the recursive `**` form. */
function hasRecursiveGlob(include: string[]): boolean {
  return include.some((g) => g.includes('**'));
}

/**
 * Scope diagnostics for recursive mode (WS1 — grep_content auto-diagnostico).
 *
 * Evidence-based on purpose: a narrow-but-intentional filter must NOT warn.
 *   1. `SEARCH_EMPTY_SCOPE` — the walker saw files but the include globs
 *      matched none (the classic one-segment-vs-double-star glob trap).
 *      Model-facing sentinel: the caller must not read "empty scope" as
 *      "pattern not found".
 *   2. Non-recursive glob dropped files that the double-star variant of the
 *      same glob would have matched → milder hint with a recursive-glob example.
 */
function scopeWarnings(allEntries: FileEntry[], include: string[], matched: number): string[] {
  const warnings: string[] = [];
  const filesWalked = allEntries.filter((e) => e.type === 'file').length;
  if (filesWalked === 0) return warnings;

  if (matched === 0) {
    warnings.push(
      `SEARCH_EMPTY_SCOPE: include globs matched 0 of ${filesWalked} files walked — ` +
        `'*' matches only one path segment; use '**/<glob>' for recursive matching. ` +
        `Do not interpret this result as "pattern not found".`,
    );
    return warnings;
  }

  if (hasRecursiveGlob(include) || matched >= filesWalked) return warnings;

  // Would the recursive variant of the SAME globs have matched more files?
  // ('**/' + g matches everything g matches, so wouldMatch >= matched holds
  //  by construction — the check below only fires on real evidence.)
  const recursiveRegexes = compileGlobs(include.map((g) => `**/${g}`));
  const wouldMatch = allEntries.filter(
    (e) => e.type === 'file' && matchesAnyCompiled(e.name, recursiveRegexes),
  ).length;
  if (wouldMatch > matched) {
    warnings.push(
      `include globs matched ${matched} of ${filesWalked} files walked — ` +
        `'*' matches only one path segment; a '**/*.ts'-style recursive glob ` +
        `would have matched ${wouldMatch - matched} more file(s) in subdirectories`,
    );
  }
  return warnings;
}

async function searchFile(
  absPath: string,
  relPath: string,
  regex: RegExp,
  contextLines: number,
  remainingSlots: number,
): Promise<{ matches: GrepMatch[]; total: number; truncated: boolean }> {
  let buf: string;
  try {
    buf = await fs.readFile(absPath, 'utf-8');
  } catch {
    return { matches: [], total: 0, truncated: false }; // unreadable file → skip
  }
  const lines = buf.split('\n');
  const matches: GrepMatch[] = [];
  let total = 0;
  let truncated = false;
  for (let i = 0; i < lines.length; i++) {
    regex.lastIndex = 0;
    if (regex.test(lines[i])) {
      total++;
      if (matches.length < remainingSlots) {
        const startBefore = Math.max(0, i - contextLines);
        const endAfter = Math.min(lines.length - 1, i + contextLines);
        matches.push({
          file: absPath,
          relPath,
          line: i + 1,
          text: lines[i],
          context: {
            before: lines.slice(startBefore, i),
            after: lines.slice(i + 1, endAfter + 1),
          },
        });
      } else {
        truncated = true;
      }
    }
  }
  return { matches, total, truncated };
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export const grepContentTool: ToolDefinition<GrepContentArgs, GrepResult> = {
  name: 'grep_content',
  description:
    'Regex search for content in a file OR recursively in a directory. ' +
    'When path is a directory, include/exclude globs filter which files are searched ' +
    '(default: all files, excluding node_modules/dist/.git/etc.). ' +
    'Glob semantics: "*" matches ONE path segment only ("*.ts" does NOT match "sub/file.ts"); ' +
    'use "**" for recursive matching ("**/*.ts" matches at any depth). ' +
    'include/exclude accept a single glob string (e.g. "*.ts") OR an array of globs. ' +
    'Returns matches with line numbers and context, plus filesWalked/filesInTree counts ' +
    'and a warning when the include globs matched suspiciously few files.',
  permissions: ['read'],
  timeoutMs: 30000,
  inputSchema: GrepContentArgsSchema,
  execute: async (args, ctx) => {
    try {
      const absRoot = path.isAbsolute(args.path) ? args.path : path.join(ctx.cwd, args.path);
      const regex = new RegExp(args.pattern, 'gm');
      // Coerce model-friendly string|string[] into string[] for the walker.
      const rawInclude = args.include;
      const include = coerceStringList(rawInclude, ['*']);
      const exclude = coerceStringList(args.exclude, DEFAULT_EXCLUDES);
      const warnings: string[] = [];
      if (Array.isArray(rawInclude) && rawInclude.length === 0) {
        // v1.46 deprecation window: accepted + loud. v1.47: min(1) → INVALID_ARGUMENT.
        warnings.push(
          'DEPRECATED_INPUT: empty include array — omit the field instead; ' +
            'this will become INVALID_ARGUMENT (planned v1.47). Fell back to ["*"]',
        );
      } else if (typeof rawInclude === 'string') {
        warnings.push(`include coerced from bare string to ${JSON.stringify(include)}`);
      }

      // ── Single-file mode ────────────────────────────────────────
      if (!(await isDirectory(absRoot))) {
        const single = await searchFile(absRoot, args.path, regex, args.contextLines, args.maxMatches);
        return typedOk({
          matches: single.matches,
          totalMatches: single.total,
          truncated: single.truncated,
          filesSearched: 1,
          filesInTree: 1,
          filesWalked: 1,
          effectiveInclude: include,
          effectiveExclude: exclude,
          ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
        });
      }

      // ── Recursive (directory) mode ──────────────────────────────
      const allEntries: FileEntry[] = [];
      await walk(absRoot, '', 0, args.maxDepth, exclude, allEntries, ctx.signal);
      const matchedFiles = filterByInclude(allEntries, include);
      const filesWalked = allEntries.filter((e) => e.type === 'file').length;
      warnings.push(...scopeWarnings(allEntries, include, matchedFiles.length));

      const allMatches: GrepMatch[] = [];
      let totalMatches = 0;
      let truncated = false;
      let filesSearched = 0;

      for (const entry of matchedFiles) {
        if (ctx.signal?.aborted) break;
        if (allMatches.length >= args.maxMatches) {
          truncated = true;
          break;
        }
        const absFile = path.join(absRoot, entry.name);
        const result = await searchFile(
          absFile,
          entry.name,
          regex,
          args.contextLines,
          args.maxMatches - allMatches.length,
        );
        filesSearched++;
        totalMatches += result.total;
        if (result.truncated) truncated = true;
        allMatches.push(...result.matches);
      }

      return typedOk({
        matches: allMatches,
        totalMatches,
        truncated,
        filesSearched,
        filesInTree: matchedFiles.length,
        filesWalked,
        effectiveInclude: include,
        effectiveExclude: exclude,
        ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
      });
    } catch (err) {
      return typedErr(err instanceof Error ? err.message : String(err));
    }
  },
};
