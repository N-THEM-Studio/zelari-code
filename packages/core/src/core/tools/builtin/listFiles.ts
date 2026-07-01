import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { typedOk, typedErr, type ToolDefinition } from '../toolTypes.js';
import {
  walk,
  DEFAULT_EXCLUDES,
  type FileEntry,
} from './_walk.js';

const ListFilesArgsSchema = z.object({
  /** Directory to list (relative to cwd or absolute). Defaults to cwd. */
  path: z.string().optional(),
  /** Max traversal depth. 1 = immediate children only (default). */
  maxDepth: z.number().int().positive().max(10).default(1),
  /** Glob-style patterns to exclude (matched against each entry name). */
  exclude: z.array(z.string()).default(DEFAULT_EXCLUDES),
});

type ListFilesArgs = z.infer<typeof ListFilesArgsSchema>;

interface ListFilesResult {
  /** The directory that was listed (absolute). */
  dir: string;
  entries: FileEntry[];
  truncated: boolean;
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
      // API: maxDepth=1 means "root only". Internally: depth=0 at root,
      // so we subtract 1 from the user-facing maxDepth.
      await walk(target, '', 0, args.maxDepth - 1, args.exclude, entries, ctx.signal);
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