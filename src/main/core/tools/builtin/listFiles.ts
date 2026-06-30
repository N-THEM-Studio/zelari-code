import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { typedOk, typedErr, type ToolDefinition } from '../toolTypes.js';

const ListFilesArgsSchema = z.object({
  /** Directory to list (relative to cwd or absolute). Defaults to cwd. */
  path: z.string().optional(),
  /** Max traversal depth. 1 = immediate children only (default). */
  maxDepth: z.number().int().positive().max(10).default(1),
  /** Glob-style patterns to exclude (matched against each entry name). */
  exclude: z.array(z.string()).default([
    'node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.cache',
  ]),
});

type ListFilesArgs = z.infer<typeof ListFilesArgsSchema>;

interface FileEntry {
  /** Path relative to the listed directory. */
  name: string;
  /** 'file' | 'directory' | 'other' (symlink, socket, etc.). */
  type: 'file' | 'directory' | 'other';
}

interface ListFilesResult {
  /** The directory that was listed (absolute). */
  dir: string;
  entries: FileEntry[];
  truncated: boolean;
}

function matchesAny(name: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    // Simple glob: '*' wildcard.
    if (p.includes('*')) {
      const regex = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      return regex.test(name);
    }
    return name === p;
  });
}

async function walk(
  dir: string,
  baseRel: string,
  depth: number,
  maxDepth: number,
  exclude: string[],
  entries: FileEntry[],
  signal: AbortSignal | undefined,
): Promise<void> {
  if (depth > maxDepth) return;
  let dirents: import('node:fs').Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable subdirectory — skip silently
  }
  // Honor the abort signal between reads (fs.readdir options.signal typing
  // varies across Node versions, so we check manually here).
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

export const listFilesTool: ToolDefinition<ListFilesArgs, ListFilesResult> = {
  name: 'list_files',
  description:
    'List files and directories in the given path (defaults to the working directory). ' +
    'Returns names with types (file/directory). Use this to discover the project structure ' +
    'before reading specific files. Supports a maxDepth for recursive listing and excludes ' +
    'common dependency/build directories by default.',
  permissions: ['read'],
  timeoutMs: 15000,
  inputSchema: ListFilesArgsSchema,
  execute: async (args, ctx) => {
    try {
      const target = args.path
        ? (path.isAbsolute(args.path) ? args.path : path.join(ctx.cwd, args.path))
        : ctx.cwd;
      const entries: FileEntry[] = [];
      await walk(target, '', 1, args.maxDepth, args.exclude, entries, ctx.signal);
      // Sort: directories first, then files, alphabetically.
      entries.sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1;
        if (a.type !== 'directory' && b.type === 'directory') return 1;
        return a.name.localeCompare(b.name);
      });
      const MAX_ENTRIES = 500;
      const truncated = entries.length > MAX_ENTRIES;
      return typedOk({ dir: target, entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries, truncated });
    } catch (err) {
      return typedErr(err instanceof Error ? err.message : String(err));
    }
  },
};
