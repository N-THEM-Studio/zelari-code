import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { typedOk, typedErr, type ToolDefinition } from '../toolTypes.js';
import { replaceFileString, snapshotIdOf } from './filesystem.js';
import { splitLinesLF } from './newlines.js';
import { emitFileEvent, fileAppliedEvent, fileRejectedEvent, reReadHint } from './fileEvents.js';

// ────────────────────────────────────────────────────────────────────────────
// WriteReject — ADR-0033 day-1 structured reject (never prose)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Structured reject payload for write-path failures (ADR-0033).
 * Every reject carries a machine action (`next`), never an essay.
 */
export const WriteRejectSchema = z.object({
  ok: z.literal(false),
  status: z.enum(['stale_snapshot', 'hunk_mismatch', 'parse_error', 'file_exists']),
  path: z.string(),
  expectedHash: z.string().optional(),
  actualHash: z.string().optional(),
  span: z
    .object({ startLine: z.number().int(), endLine: z.number().int() })
    .optional(),
  minimalDiff: z.string(),
  next: z.object({ action: z.literal('re-read'), path: z.string() }),
});

export type WriteReject = z.infer<typeof WriteRejectSchema>;

// ────────────────────────────────────────────────────────────────────────────
// applyAnchoredEdit — the single write engine (two gates in series)
// ────────────────────────────────────────────────────────────────────────────

export interface AnchoredEditInput {
  /** Current file content (freshly read by the caller; the engine never touches disk). */
  content: string;
  /** Anchor claimed by the caller: snapshotId from the last read_file of this path. */
  expectedSnapshotId: string;
  oldString: string;
  newString: string;
  replaceAll: boolean;
  /** Path used in reject payloads and diff labels. */
  path: string;
}

export type AnchoredEditResult =
  | { ok: true; newContent: string; occurrencesReplaced: number; snapshotId: string }
  | { ok: false; reject: WriteReject };

/**
 * ADR-0033 edit protocol, pure engine:
 *
 * Gate 1 — snapshot anchor. `expectedSnapshotId !== sha256(current)[:16]`
 * → `stale_snapshot` WITHOUT any apply attempt. The caller re-reads;
 * the engine never "tries nearby".
 *
 * Gate 2 — exact region match via `replaceFileString`. The ONLY tolerance is
 * deterministic LF/CRLF normalization: the engine may normalize bytes,
 * it may never move the region (zero relocation, zero context scanning).
 * 0 occurrences → `hunk_mismatch` + `minimalDiff`, no write.
 */
export function applyAnchoredEdit(input: AnchoredEditInput): AnchoredEditResult {
  const actualHash = snapshotIdOf(input.content);
  const next = { action: 're-read' as const, path: input.path };

  // Gate 1: file-level snapshot. No match attempt happens on a stale anchor.
  if (input.expectedSnapshotId !== actualHash) {
    return {
      ok: false,
      reject: {
        ok: false,
        status: 'stale_snapshot',
        path: input.path,
        expectedHash: input.expectedSnapshotId,
        actualHash,
        minimalDiff: '', // no expected-content diff is possible from a hash alone
        next,
      },
    };
  }

  // Gate 2: exact match (LF/CRLF-normalized), always on the anchored region.
  const { occurrences, newContent } = replaceFileString(
    input.content,
    input.oldString,
    input.newString,
    input.replaceAll,
  );
  if (occurrences === 0) {
    const { minimalDiff, span } = conflictMinimalDiff(input.content, input.oldString, input.path);
    return {
      ok: false,
      reject: {
        ok: false,
        status: 'hunk_mismatch',
        path: input.path,
        ...(span ? { span } : {}),
        minimalDiff,
        next,
      },
    };
  }

  return {
    ok: true,
    newContent,
    occurrencesReplaced: occurrences,
    snapshotId: snapshotIdOf(newContent),
  };
}

/**
 * Minimal conflict context for `hunk_mismatch`: a short unified diff around
 * the best APPROXIMATE match of oldString's first distinctive line, or — when
 * nothing plausible exists — the first span of the file next to the first
 * lines of oldString.
 *
 * DIAGNOSTIC ONLY: this scan never influences the apply path, which stays
 * exact (ADR-0033: zero relocation).
 */
function conflictMinimalDiff(
  content: string,
  oldString: string,
  pathLabel: string,
): { minimalDiff: string; span?: { startLine: number; endLine: number } } {
  const fileLines = splitLinesLF(content);
  const oldLines = splitLinesLF(oldString);
  const needle = oldLines.find((l) => l.trim().length > 0) ?? '';

  let anchor = -1;
  if (needle) {
    anchor = fileLines.indexOf(needle);
    if (anchor === -1) {
      let best = 0.5;
      for (let i = 0; i < fileLines.length; i++) {
        const score = lineSimilarity(fileLines[i] ?? '', needle);
        if (score > best) {
          best = score;
          anchor = i;
        }
      }
    }
  }

  if (anchor === -1) {
    // No plausible anchor: show the first span of the file vs oldString's head.
    const len = Math.min(fileLines.length, Math.max(1, oldLines.length));
    const body = [
      ...fileLines.slice(0, len).map((l) => ` ${l}`),
      ...oldLines.slice(0, len).map((l) => `+${l}`),
    ];
    return {
      minimalDiff: [
        `--- ${pathLabel}`,
        `+++ ${pathLabel}`,
        `@@ -1,${len} +1,${len} @@`,
        ...body,
      ].join('\n'),
      span: { startLine: 0, endLine: len },
    };
  }

  const CTX = 3; // ~3 context lines around the approximate conflict site
  const start = Math.max(0, anchor - CTX);
  const end = Math.min(fileLines.length, anchor + Math.max(1, oldLines.length) + CTX);
  const body: string[] = [];
  for (let i = start; i < end; i++) {
    const inClaim = i >= anchor && i < anchor + oldLines.length;
    body.push(`${inClaim ? '-' : ' '}${fileLines[i] ?? ''}`);
  }
  for (const l of oldLines) body.push(`+${l}`); // what the edit expected to find
  return {
    minimalDiff: [
      `--- ${pathLabel}`,
      `+++ ${pathLabel}`,
      `@@ -${start + 1},${end - start} +${start + 1},${end - start} @@`,
      ...body,
    ].join('\n'),
    span: { startLine: start, endLine: end },
  };
}

/** Cheap bounded similarity (capped Levenshtein) for approximate anchoring of the conflict report. */
function lineSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const A = a.slice(0, 240);
  const B = b.slice(0, 240);
  const max = Math.max(A.length, B.length);
  if (max === 0) return 1;
  // Length prefilter: wildly different lengths cannot be near-duplicates.
  if (Math.abs(A.length - B.length) / max > 0.6) return 0;
  let prev = new Array<number>(B.length + 1);
  let curr = new Array<number>(B.length + 1);
  for (let j = 0; j <= B.length; j++) prev[j] = j;
  for (let i = 1; i <= A.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= B.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1),
      );
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return 1 - prev[B.length] / max;
}

// ────────────────────────────────────────────────────────────────────────────
// edit tool — the anchored write surface for the model
// ────────────────────────────────────────────────────────────────────────────

export const EditArgsSchema = z.object({
  path: z.string().min(1),
  oldString: z.string().min(1),
  newString: z.string(),
  /** Anchor from the last read_file of this path (sha256 of full content, 16 hex chars). */
  snapshotId: z.string().length(16),
  replaceAll: z.boolean().default(false),
});

type EditArgs = z.infer<typeof EditArgsSchema>;

interface EditResult {
  path: string;
  applied: true;
  occurrencesReplaced: number;
  /** Anchor of the POST-edit content — required by the next `edit` on this path. */
  snapshotId: string;
  bytesWritten: number;
}

export const editTool: ToolDefinition<EditArgs, EditResult> = {
  name: 'edit',
  description:
    'Anchored edit: requires the snapshotId returned by the last read_file of this path. ' +
    'Rejects (stale_snapshot) if the file changed since; never relocates the target region. ' +
    'Matching tolerates CRLF vs LF only; the file keeps its original line endings. ' +
    'Structured rejects ride in meta.reject (WriteReject) with next: {action: "re-read"}.',
  permissions: ['write'],
  sideEffect: 'local',
  timeoutMs: 10000,
  inputSchema: EditArgsSchema,
  execute: async (args, ctx) => {
    try {
      const absPath = path.isAbsolute(args.path) ? args.path : path.join(ctx.cwd, args.path);
      let text: string;
      try {
        const buf = await fs.readFile(absPath, { encoding: 'utf-8', signal: ctx.signal } as never);
        text = typeof buf === 'string' ? buf : buf.toString('utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          // Named failure (repo convention), not a raw ENOENT dump.
          return typedErr(`edit: file not found: ${args.path} (FILE_NOT_FOUND).`, {
            status: 'failed',
            warnings: ['FILE_NOT_FOUND'],
          });
        }
        throw err;
      }
      const result = applyAnchoredEdit({
        content: text,
        expectedSnapshotId: args.snapshotId,
        oldString: args.oldString,
        newString: args.newString,
        replaceAll: args.replaceAll,
        path: absPath,
      });
      if (!result.ok) {
        // Brief machine-prefixed message; the full structured payload is meta.reject.
        const detail =
          result.reject.status === 'stale_snapshot'
            ? `(expected ${result.reject.expectedHash}, actual ${result.reject.actualHash})`
            : '(oldString not found — no relocation attempted)';
        // ADR-0033 (t75): file.rejected telemetry — reason = WriteReject.status.
        await emitFileEvent(
          ctx.emitSessionEvent,
          fileRejectedEvent(absPath, result.reject.status, reReadHint(result.reject)),
        );
        return typedErr(`edit: ${result.reject.status}: ${args.path} ${detail}`, {
          status: 'failed',
          warnings: [result.reject.status === 'stale_snapshot' ? 'STALE_SNAPSHOT' : 'HUNK_MISMATCH'],
          reject: result.reject,
        });
      }
      await fs.writeFile(absPath, result.newContent, {
        encoding: 'utf-8',
        signal: ctx.signal,
      } as never);
      // ADR-0033 (t75): file.applied telemetry, after the durable write succeeded.
      await emitFileEvent(
        ctx.emitSessionEvent,
        fileAppliedEvent(absPath, result.snapshotId, result.newContent.length),
      );
      return typedOk({
        path: absPath,
        applied: true,
        occurrencesReplaced: result.occurrencesReplaced,
        snapshotId: result.snapshotId,
        bytesWritten: result.newContent.length,
      });
    } catch (err) {
      return typedErr(err instanceof Error ? err.message : String(err));
    }
  },
};
