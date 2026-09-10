/**
 * session/replayCache.ts — Int4a incremental replay cache for long sessions.
 *
 * `readSessionLog()` re-reads the WHOLE JSONL and Zod-parses every line on
 * every call, and the spine does it 2–8 times per turn: O(n²) in session
 * length. This cache keeps the parsed events per file and, on a later call,
 * reads only the bytes appended since the last read (COMPLETE lines only).
 *
 * Invariants:
 *   - `byteSize` is what the entry OWNS: every complete line consumed plus the
 *     bytes held in `partial`. It always sits on a UTF-8 character boundary, so
 *     the next read starts exactly there and no byte is ever parsed twice.
 *   - A tail without its final '\n' stays in `partial` and is NOT an event yet:
 *     it appears exactly once, when the writer completes the line. A tail
 *     ending INSIDE a multi-byte character is not consumed at all (re-read from
 *     a boundary) — a torn write can never poison the cache with U+FFFD.
 *   - Shrink (`size < byteSize`) or a backwards mtime (rotation / in-place
 *     rewrite) ⇒ full re-read through the SAME parse path as `readSessionLog`,
 *     so a replaced log is never served from stale entries.
 *   - The returned ReplayReport is fresh (caller-owned arrays); the envelopes
 *     inside are shared and treat-as-immutable — the spine contract.
 *   - Known deviation: a COLD read (empty cache / rotation) consumes a
 *     non-terminated last line exactly as `readSessionLog` does today; only
 *     appends observed while warm are deferred into `partial`. The writer
 *     always terminates lines with '\n', so this needs external truncation.
 *
 * Kill switch `ZELARI_SPINE_REPLAY_CACHE`: DEFAULT OFF in this merge (dogfood
 * first) — set `1`/`true`/`yes`/`on` to enable. When unset/0/false/off,
 * `readSessionLogCached` calls the existing `readSessionLog` verbatim.
 */

import { promises as fs } from 'node:fs';
import {
  readSessionLog,
  parseSessionLogLines,
  type ReplayIssue,
  type ReplayReport,
} from './replay.js';
import type { SessionEventEnvelope } from './types.js';

type FileHandle = Awaited<ReturnType<typeof fs.open>>;
/** Only the two fields this cache reads (keeps the node Stats overloads out). */
type FileStat = { size: number; mtimeMs: number };

/** `ZELARI_SPINE_REPLAY_CACHE` (default OFF): truthy spelling = 1/true/yes/on. */
export function isReplayCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.ZELARI_SPINE_REPLAY_CACHE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export interface ReplayCacheEntry {
  /** Bytes owned by this entry: complete lines + the bytes held in `partial`. */
  byteSize: number;
  mtimeMs: number;
  events: SessionEventEnvelope[];
  issues: ReplayIssue[];
  /** Seq the next event must carry to be accepted gap-free. */
  expectedSeq: number;
  /** Tail without a final '\n' (writer crash mid-line) — not yet an event. */
  partial: string;
  /**
   * Lines consumed so far, blank/corrupt ones included, so a new issue keeps
   * its ORIGINAL 1-based file line number (`linesConsumed + index + 1`).
   * Additive to the planned entry shape: without it an incremental read would
   * renumber issues and stop being equivalent to `readSessionLog`.
   */
  linesConsumed: number;
}

const NL = 0x0a;

/** >0 when `buf` ends inside a multi-byte UTF-8 sequence (bytes to leave unread). */
function utf8IncompleteTailBytes(buf: Buffer): number {
  const max = Math.min(4, buf.length);
  for (let back = 1; back <= max; back++) {
    const b = buf[buf.length - back]!;
    if (b < 0x80) return 0; // ASCII tail — complete
    if (b >= 0xc0) {
      // Lead byte: it must be followed by (need - 1) continuation bytes.
      const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
      return back >= need ? 0 : need - back;
    }
    // 0x80..0xbf = continuation byte — walk back to its lead byte.
  }
  return 0; // no lead byte within 4 bytes: malformed anyway, let JSON.parse judge
}

/** Read exactly `length` bytes at `position` (a live writer may shorten reads). */
async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, position + done);
    if (bytesRead === 0) break; // truncated under us — parse what we got
    done += bytesRead;
  }
  return done === length ? buf : buf.subarray(0, done);
}

/** Fresh report over the cached arrays — a consumer may mutate them freely. */
function toReport(filePath: string, entry: ReplayCacheEntry): ReplayReport {
  const events = entry.events.slice();
  const issues = entry.issues.slice();
  return { path: filePath, events, issues, ok: issues.length === 0 };
}

/**
 * Incremental replay cache. Own ONE instance per session (the spine mirror owns
 * its own); entries are keyed by file path, so concurrent sessions never share
 * decoded state.
 */
export class SessionLogCache {
  private readonly entries = new Map<string, ReplayCacheEntry>();

  /** Files currently cached (diagnostics). */
  get size(): number {
    return this.entries.size;
  }

  /** The cached entry for `filePath` (copy; tests + diagnostics), if any. */
  peek(filePath: string): ReplayCacheEntry | undefined {
    const entry = this.entries.get(filePath);
    return entry ? { ...entry } : undefined;
  }

  /** Read the log, incrementally when a usable entry exists. */
  async read(filePath: string): Promise<ReplayReport> {
    const cached = this.entries.get(filePath);
    let stat: FileStat;
    try {
      stat = await fs.stat(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.entries.delete(filePath);
        return { path: filePath, events: [], issues: [], ok: true };
      }
      throw err;
    }
    if (cached && stat.size >= cached.byteSize && stat.mtimeMs >= cached.mtimeMs) {
      if (stat.size > cached.byteSize) return this.extend(filePath, cached, stat);
      return toReport(filePath, cached); // nothing new — no I/O at all
    }
    return this.full(filePath, stat);
  }

  /** Append-path read: only the bytes written since the last read are parsed. */
  private async extend(
    filePath: string,
    cached: ReplayCacheEntry,
    stat: FileStat,
  ): Promise<ReplayReport> {
    const fh = await fs.open(filePath, 'r');
    let chunk: Buffer;
    try {
      chunk = await readAt(fh, cached.byteSize, stat.size - cached.byteSize);
    } finally {
      await fh.close();
    }
    const nl = chunk.lastIndexOf(NL);
    const headEnd = nl === -1 ? 0 : nl + 1; // end of the last COMPLETE line
    const tail = chunk.subarray(headEnd);
    // PERF-4a: bytes of the tail that decode cleanly. A tail ending INSIDE a
    // multi-byte char stays unconsumed and is re-read from a boundary, so
    // `partial` is never a U+FFFD-mangled fragment.
    const keep = tail.subarray(0, tail.length - utf8IncompleteTailBytes(tail));
    // The old `partial` is folded into `head` only once a newline arrives; while
    // no line completes it stays in front of the unconsumed tail.
    const head = cached.partial + chunk.subarray(0, headEnd).toString('utf8');
    const lines = headEnd > 0 ? head.split('\n').slice(0, -1) : [];
    const parsed = parseSessionLogLines(lines, {
      expected: cached.expectedSeq,
      linesConsumed: cached.linesConsumed,
    });
    const entry: ReplayCacheEntry = {
      byteSize: cached.byteSize + headEnd + keep.length,
      mtimeMs: stat.mtimeMs,
      events: parsed.events.length > 0 ? cached.events.concat(parsed.events) : cached.events,
      issues: parsed.issues.length > 0 ? cached.issues.concat(parsed.issues) : cached.issues,
      expectedSeq: parsed.expected,
      partial: (headEnd > 0 ? '' : cached.partial) + keep.toString('utf8'),
      linesConsumed: parsed.linesConsumed,
    };
    this.entries.set(filePath, entry);
    return toReport(filePath, entry);
  }

  /** Cold / rotated read: same parse as `readSessionLog`, then seed the entry. */
  private async full(filePath: string, stat: FileStat): Promise<ReplayReport> {
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.entries.delete(filePath);
        return { path: filePath, events: [], issues: [], ok: true };
      }
      throw err;
    }
    const lines = content.split('\n');
    const parsed = parseSessionLogLines(lines);
    // Count the lines this read consumed: the split's trailing '' is the
    // artificial piece after the final '\n'; a torn tail is already parsed.
    const linesConsumed = content.length === 0 ? 0 : content.endsWith('\n') ? lines.length - 1 : lines.length;
    const entry: ReplayCacheEntry = {
      // Bytes actually read (never the pre-read stat: the log may have grown).
      byteSize: Buffer.byteLength(content, 'utf8'),
      mtimeMs: stat.mtimeMs,
      events: parsed.events,
      issues: parsed.issues,
      expectedSeq: parsed.expected,
      partial: '',
      linesConsumed,
    };
    this.entries.set(filePath, entry);
    return { path: filePath, events: entry.events.slice(), issues: entry.issues.slice(), ok: entry.issues.length === 0 };
  }
}

/**
 * Cached read of a session log. Without a cache — or with the kill switch off
 * (the default in this merge) — this is `readSessionLog` verbatim.
 */
export async function readSessionLogCached(
  filePath: string,
  cache?: SessionLogCache,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReplayReport> {
  if (!cache || !isReplayCacheEnabled(env)) return readSessionLog(filePath);
  return cache.read(filePath);
}
