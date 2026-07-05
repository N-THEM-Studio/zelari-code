import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { typedOk, typedErr, type ToolDefinition } from '../toolTypes.js';

const ReadFileArgsSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().nonnegative().optional(),
  endLine: z.number().int().positive().optional(),
  maxBytes: z.number().int().positive().max(10_000_000).default(1_000_000),
});

type ReadFileArgs = z.infer<typeof ReadFileArgsSchema>;

interface ReadFileResult {
  path: string;
  content: string;
  totalLines: number;
  readLines: { start: number; end: number };
  sizeBytes: number;
}

export const readFileTool: ToolDefinition<ReadFileArgs, ReadFileResult> = {
  name: 'read_file',
  description: 'Read a file with optional line range. Returns content + metadata. Use before edit_file.',
  permissions: ['read'],
  timeoutMs: 5000,
  inputSchema: ReadFileArgsSchema,
  execute: async (args, ctx) => {
    try {
      const absPath = path.isAbsolute(args.path) ? args.path : path.join(ctx.cwd, args.path);
      const buf = await fs.readFile(absPath, { encoding: 'utf-8', signal: ctx.signal } as never);
      const content = typeof buf === 'string' ? buf : buf.toString('utf-8');
      const truncated = content.length > args.maxBytes ? content.slice(0, args.maxBytes) : content;
      const lines = truncated.split('\n');
      const totalLines = content.split('\n').length;
      const start = args.startLine ?? 0;
      const end = Math.min(args.endLine ?? lines.length, lines.length);
      return typedOk({
        path: absPath,
        content: lines.slice(start, end).join('\n'),
        totalLines,
        readLines: { start, end: end - 1 },
        sizeBytes: content.length,
      });
    } catch (err) {
      return typedErr(err instanceof Error ? err.message : String(err));
    }
  },
};

const WriteFileArgsSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  createDirs: z.boolean().default(false),
});

type WriteFileArgs = z.infer<typeof WriteFileArgsSchema>;

interface WriteFileResult {
  path: string;
  bytesWritten: number;
}

export const writeFileTool: ToolDefinition<WriteFileArgs, WriteFileResult> = {
  name: 'write_file',
  description: 'Write or create a file. Use createDirs=true to auto-create parent directories.',
  permissions: ['write'],
  timeoutMs: 10000,
  inputSchema: WriteFileArgsSchema,
  execute: async (args, ctx) => {
    try {
      const absPath = path.isAbsolute(args.path) ? args.path : path.join(ctx.cwd, args.path);
      if (args.createDirs) {
        await fs.mkdir(path.dirname(absPath), { recursive: true });
      }
      await fs.writeFile(absPath, args.content, { encoding: 'utf-8', signal: ctx.signal } as never);
      return typedOk({ path: absPath, bytesWritten: args.content.length });
    } catch (err) {
      return typedErr(err instanceof Error ? err.message : String(err));
    }
  },
};

const EditFileArgsSchema = z.object({
  path: z.string().min(1),
  oldString: z.string().min(1),
  newString: z.string(),
  replaceAll: z.boolean().default(false),
});

type EditFileArgs = z.infer<typeof EditFileArgsSchema>;

interface EditFileResult {
  path: string;
  occurrencesReplaced: number;
}

export const editFileTool: ToolDefinition<EditFileArgs, EditFileResult> = {
  name: 'edit_file',
  description: 'Replace exact string match in a file. Idempotent: returns 0 occurrences if no match.',
  permissions: ['write'],
  timeoutMs: 10000,
  inputSchema: EditFileArgsSchema,
  execute: async (args, ctx) => {
    try {
      const absPath = path.isAbsolute(args.path) ? args.path : path.join(ctx.cwd, args.path);
      const content = await fs.readFile(absPath, { encoding: 'utf-8', signal: ctx.signal } as never);
      const text = typeof content === 'string' ? content : content.toString('utf-8');
      let occurrences = 0;
      let newContent: string;
      if (args.replaceAll) {
        const parts = text.split(args.oldString);
        occurrences = parts.length - 1;
        newContent = parts.join(args.newString);
      } else {
        const idx = text.indexOf(args.oldString);
        if (idx === -1) {
          occurrences = 0;
          newContent = text;
        } else {
          occurrences = 1;
          newContent = text.slice(0, idx) + args.newString + text.slice(idx + args.oldString.length);
        }
      }
      if (occurrences === 0) {
        return typedErr(
          `edit_file: no match for oldString in ${args.path}. ` +
            'Use read_file to copy the exact text (whitespace included) and retry.',
        );
      }
      await fs.writeFile(absPath, newContent, { encoding: 'utf-8', signal: ctx.signal } as never);
      return typedOk({ path: absPath, occurrencesReplaced: occurrences });
    } catch (err) {
      return typedErr(err instanceof Error ? err.message : String(err));
    }
  },
};
