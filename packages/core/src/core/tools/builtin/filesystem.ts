import { z } from 'zod';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { typedOk, typedErr, type ToolDefinition } from '../toolTypes.js';
import { detectNewline, fromLF, splitLinesLF, toLF } from './newlines.js';
import { emitFileEvent, fileReadEvent } from './fileEvents.js';

/**
 * ADR-0033 snapshot anchor: sha256 of the FULL (pre-truncation) content,
 * hex, first 16 chars. Deterministic: same content → same id. `read_file`
 * returns it; `edit` requires it back (optimistic lock between tentacles).
 */
export function snapshotIdOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

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
  /** ADR-0033 anchor: sha256 of the full (pre-truncation) content, 16 hex chars. */
  snapshotId: string;
}

export const readFileTool: ToolDefinition<ReadFileArgs, ReadFileResult> = {
  name: 'read_file',
  description:
    'Read a file with optional 0-based line range (endLine exclusive). ' +
    'maxBytes caps the selected range, not a prefix of the file. ' +
    'Returns content + snapshotId (sha256 of the FULL content, first 16 hex chars): ' +
    'pass this anchor to the `edit` tool — it rejects with stale_snapshot if the file ' +
    'changed since this read. Use before edit.',
  permissions: ['read'],
  sideEffect: 'none',
  timeoutMs: 5000,
  inputSchema: ReadFileArgsSchema,
  execute: async (args, ctx) => {
    try {
      const absPath = path.isAbsolute(args.path) ? args.path : path.join(ctx.cwd, args.path);
      const buf = await fs.readFile(absPath, { encoding: 'utf-8', signal: ctx.signal } as never);
      const content = typeof buf === 'string' ? buf : buf.toString('utf-8');
      // Anchor is computed on the INTEGR file, before any line-range/maxBytes cut.
      const snapshotId = snapshotIdOf(content);
      // ADR-0033 (t75): file.read telemetry — the read that produced this anchor.
      await emitFileEvent(ctx.emitSessionEvent, fileReadEvent(absPath, snapshotId));
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
          snapshotId,
        },
        {
          status,
          counts: { bytes: content.length, lines: totalLines },
          snapshotId,
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
  /**
   * ADR-0033 file_exists guard. Absent/false: an existing target is NEVER
   * clobbered — the tool rejects with a structured `file_exists` WriteReject
   * and writes nothing. Explicit `true` allows replacement only when
   * `expectedHash` matches the current snapshotId, or `force` is set.
   */
  overwrite: z.boolean().optional(),
  /**
   * K2.2 / F10: sha256[:16] of the current on-disk contents (same as
   * `read_file` snapshotId). Required with overwrite:true on an existing
   * file unless `force` is true.
   */
  expectedHash: z.string().optional(),
  /**
   * K2.2 / F10: explicit unanchored overwrite. Result marks
   * `forcedOverwrite: true` (not silent). Prefer expectedHash.
   */
  force: z.boolean().optional(),
});

type WriteFileArgs = z.infer<typeof WriteFileArgsSchema>;

interface WriteFileResult {
  path: string;
  bytesWritten: number;
  /** Set when overwrite proceeded via force:true without a matching expectedHash. */
  forcedOverwrite?: boolean;
}

/**
 * ADR-0033 `file_exists` diagnostic: head of the on-disk content (`-`) vs
 * head of the incoming content (`+`), unified-like, bounded (~10 existing
 * lines, body capped at ~40). Diagnostic only — no write happened.
 */
function fileExistsMinimalDiff(existing: string, incoming: string, pathLabel: string): string {
  const EXISTING_HEAD_LINES = 10;
  const MAX_BODY_LINES = 40;
  const oldHead = splitLinesLF(existing).slice(0, EXISTING_HEAD_LINES);
  const newHead = splitLinesLF(incoming).slice(0, MAX_BODY_LINES - oldHead.length);
  return [
    `--- ${pathLabel}`,
    `+++ ${pathLabel}`,
    `@@ -1,${oldHead.length} +1,${newHead.length} @@`,
    ...oldHead.map((l) => `-${l}`),
    ...newHead.map((l) => `+${l}`),
  ].join('\n');
}

export const writeFileTool: ToolDefinition<WriteFileArgs, WriteFileResult> = {
  name: 'write_file',
  description:
    'Write or create a file. Use createDirs=true to auto-create parent directories. ' +
    'If the target already exists and overwrite is not true, rejects with a structured ' +
    'file_exists WriteReject (meta.reject) and writes nothing — read it first with read_file, ' +
    'then use edit with its snapshotId. overwrite:true on an existing file requires expectedHash ' +
    '(snapshotId of the current contents) or force:true; otherwise rejects with stale_content ' +
    'and next: {action: "re-read"}.',
  permissions: ['write'],
  sideEffect: 'local',
  timeoutMs: 10000,
  inputSchema: WriteFileArgsSchema,
  execute: async (args, ctx) => {
    try {
      const absPath = path.isAbsolute(args.path) ? args.path : path.join(ctx.cwd, args.path);
      let existing: string | null = null;
      try {
        const buf = await fs.readFile(absPath, { encoding: 'utf-8', signal: ctx.signal } as never);
        existing = typeof buf === 'string' ? buf : buf.toString('utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
      }
      let forcedOverwrite = false;
      if (existing !== null) {
        if (!args.overwrite) {
          // ADR-0033: write_file creates, it never silently clobbers.
          return typedErr(
            `write_file: ${args.path} already exists (FILE_EXISTS). ` +
              'Read it with read_file and use edit with its snapshotId, or pass overwrite: true ' +
              'with expectedHash (or force: true).',
            {
              status: 'failed',
              warnings: ['FILE_EXISTS'],
              reject: {
                ok: false,
                status: 'file_exists',
                path: absPath,
                minimalDiff: fileExistsMinimalDiff(existing, args.content, absPath),
                next: { action: 're-read', path: absPath },
              },
            },
          );
        }
        // K2.2 / F10: overwrite:true is anchored (expectedHash) or explicit (force).
        const currentHash = snapshotIdOf(existing);
        const claimed =
          typeof args.expectedHash === 'string' && args.expectedHash.length > 0
            ? args.expectedHash
            : undefined;
        if (claimed !== undefined) {
          if (claimed !== currentHash) {
            return typedErr(
              `write_file: stale_content: ${args.path} (expected ${claimed}, actual ${currentHash}). ` +
                'Re-read with read_file and retry with the fresh snapshotId as expectedHash, or pass force: true.',
              {
                status: 'failed',
                warnings: ['STALE_CONTENT'],
                reject: {
                  ok: false,
                  status: 'stale_content',
                  path: absPath,
                  expectedHash: claimed,
                  actualHash: currentHash,
                  minimalDiff: fileExistsMinimalDiff(existing, args.content, absPath),
                  next: { action: 're-read', path: absPath },
                },
              },
            );
          }
        } else if (args.force === true) {
          forcedOverwrite = true;
        } else {
          return typedErr(
            `write_file: stale_content: ${args.path}. ` +
              'Existing-file overwrite requires expectedHash (read_file snapshotId of the current contents) ' +
              'or force: true.',
            {
              status: 'failed',
              warnings: ['STALE_CONTENT'],
              reject: {
                ok: false,
                status: 'stale_content',
                path: absPath,
                actualHash: currentHash,
                minimalDiff: fileExistsMinimalDiff(existing, args.content, absPath),
                next: { action: 're-read', path: absPath },
              },
            },
          );
        }
      }
      if (args.createDirs) {
        await fs.mkdir(path.dirname(absPath), { recursive: true });
      }
      await fs.writeFile(absPath, args.content, { encoding: 'utf-8', signal: ctx.signal } as never);
      return typedOk(
        {
          path: absPath,
          bytesWritten: args.content.length,
          ...(forcedOverwrite ? { forcedOverwrite: true as const } : {}),
        },
        forcedOverwrite ? { status: 'complete', warnings: ['FORCED_OVERWRITE'] } : undefined,
      );
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
