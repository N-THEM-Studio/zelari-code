import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { typedOk, typedErr, type ToolDefinition } from '../toolTypes.js';
import { detectNewline, fromLF, toLF } from './newlines.js';

const ReadFileArgsSchema = z.object({
  path: z.string().min(1),
  startLine: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('0-based first line to include. Range is applied to the full file before maxBytes.'),
  endLine: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Exclusive 0-based end line. Omit to read through EOF (still capped by maxBytes).'),
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
  description:
    'Read a file with optional 0-based line range (endLine exclusive). ' +
    'maxBytes caps the selected range, not a prefix of the file. ' +
    'Returns content + metadata. Use before edit_file.',
  permissions: ['read'],
  sideEffect: 'none',
  timeoutMs: 5000,
  inputSchema: ReadFileArgsSchema,
  execute: async (args, ctx) => {
    try {
      const absPath = path.isAbsolute(args.path) ? args.path : path.join(ctx.cwd, args.path);
      const buf = await fs.readFile(absPath, { encoding: 'utf-8', signal: ctx.signal } as never);
      const content = typeof buf === 'string' ? buf : buf.toString('utf-8');
      const allLines = content.split('\n');
      const totalLines = allLines.length;
      const start = args.startLine ?? 0;
      const endExclusive = Math.min(args.endLine ?? totalLines, totalLines);
      const empty = content.length === 0;
      const rangeEmpty = !empty && (start >= totalLines || endExclusive <= start);
      const selected = rangeEmpty ? [] : allLines.slice(start, endExclusive);
      let text = selected.join('\n');
      const wasTruncated = text.length > args.maxBytes;
      if (wasTruncated) text = text.slice(0, args.maxBytes);
      const returnedLines = text.length === 0 ? 0 : text.split('\n').length;
      const readEnd = returnedLines === 0 ? Math.max(0, start - 1) : start + returnedLines - 1;
      // Ground Truth: complete vs maxBytes-truncated vs empty-file; caps explicit.
      const status = empty || rangeEmpty ? 'empty' : wasTruncated ? 'partial' : 'complete';
      const warnings: string[] = [];
      if (empty) warnings.push('EMPTY_FILE');
      if (rangeEmpty) warnings.push('LINE_RANGE_EMPTY');
      if (wasTruncated) warnings.push('MAX_BYTES_TRUNCATED');
      return typedOk(
        {
          path: absPath,
          content: text,
          totalLines,
          readLines: { start, end: readEnd },
          sizeBytes: content.length,
        },
        {
          status,
          counts: { bytes: content.length, lines: totalLines },
          ...(warnings.length > 0 ? { warnings } : {}),
          ...(wasTruncated ? { truncated: true } : {}),
        },
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        // Ground Truth: named failure instead of a raw ENOENT dump.
        return typedErr(
          `read_file: file not found: ${args.path} (FILE_NOT_FOUND).`,
          { status: 'failed', warnings: ['FILE_NOT_FOUND'] },
        );
      }
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
  sideEffect: 'local',
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

/**
 * Byte-exact replace first; if that misses (typical: model LF vs file CRLF),
 * retry on newline-normalized text and restore the file's original terminator.
 */
export function replaceFileString(
  text: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): { occurrences: number; newContent: string } {
  const exact = replaceOnceOrAll(text, oldString, newString, replaceAll);
  if (exact.occurrences > 0) return exact;
  const nl = detectNewline(text);
  const normalized = replaceOnceOrAll(toLF(text), toLF(oldString), toLF(newString), replaceAll);
  if (normalized.occurrences === 0) return normalized;
  return { occurrences: normalized.occurrences, newContent: fromLF(normalized.newContent, nl) };
}

function replaceOnceOrAll(
  text: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): { occurrences: number; newContent: string } {
  if (replaceAll) {
    if (!text.includes(oldString)) return { occurrences: 0, newContent: text };
    const parts = text.split(oldString);
    return { occurrences: parts.length - 1, newContent: parts.join(newString) };
  }
  const idx = text.indexOf(oldString);
  if (idx === -1) return { occurrences: 0, newContent: text };
  return {
    occurrences: 1,
    newContent: text.slice(0, idx) + newString + text.slice(idx + oldString.length),
  };
}

export const editFileTool: ToolDefinition<EditFileArgs, EditFileResult> = {
  name: 'edit_file',
  description:
    'Replace a string in a file. Matching ignores CRLF vs LF; the file keeps its ' +
    'original line endings. Returns an error if oldString is not found.',
  permissions: ['write'],
  sideEffect: 'local',
  timeoutMs: 10000,
  inputSchema: EditFileArgsSchema,
  execute: async (args, ctx) => {
    try {
      const absPath = path.isAbsolute(args.path) ? args.path : path.join(ctx.cwd, args.path);
      const content = await fs.readFile(absPath, { encoding: 'utf-8', signal: ctx.signal } as never);
      const text = typeof content === 'string' ? content : content.toString('utf-8');
      const { occurrences, newContent } = replaceFileString(
        text,
        args.oldString,
        args.newString,
        args.replaceAll,
      );
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
