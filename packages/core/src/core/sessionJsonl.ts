/**
 * sessionJsonl — append-only JSONL sidecar writer for a single agent session.
 *
 * Every {@link BrainEvent} is appended as one JSON object per line so the raw
 * session transcript can be inspected with `cat`, `jq`, or any text editor.
 * Each session gets its own file under `<baseDir>/<sessionId>.jsonl`.
 *
 * Pure `node:fs` — zero Electron deps, so this module is browser-importable
 * for jsdom tests. The main-process caller passes `<userData>/sessions` as
 * `baseDir`; tests pass a temp dir.
 *
 * v1.35 batching: the streaming hot path emits `message_delta` events at
 * 50-200/sec, and the old per-event `mkdir` + `appendFile` + inline await
 * serialized the render loop with three syscalls per token. Events are now
 * line-buffered and flushed in one `appendFile` when either threshold is
 * hit (32 events / 64KB), on a 250ms cadence, or on an explicit
 * {@link SessionJsonlWriter.flush} at turn boundaries. Ordering is
 * preserved by chaining; the crash window shrinks to the un-flushed tail.
 *
 * @see docs/plans/2026-06-28-zelari-code.md (Task 12.3)
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { BrainEvent } from '../shared/events.js';

export interface SessionJsonlOptions {
  /** Base directory for session files. Defaults to `<userData>/sessions/`
   *  in main process; tests can pass a temp dir explicitly. */
  baseDir?: string;
  /** Optional logger callback (defaults to console.error). */
  onError?: (message: string) => void;
  /** Flush cadence in ms (tests can pass 0-style small values). */
  flushIntervalMs?: number;
}

/** Batched flush thresholds. */
const MAX_PENDING_EVENTS = 32;
const MAX_PENDING_BYTES = 64 * 1024;
const DEFAULT_FLUSH_INTERVAL_MS = 250;

/**
 * Append-only JSONL writer for a single session.
 *
 * One JSON object per line, shape:
 *   {"ts": <epoch-ms>, "sessionId": "<uuid>", "event": { ...BrainEvent }}
 *
 * Malformed lines on read are skipped (with a warning) so the file is
 * always recoverable via `readSession()`.
 */
export class SessionJsonlWriter {
  private readonly filePath: string;
  private readonly onError: (msg: string) => void;
  private readonly flushIntervalMs: number;
  private pending: string[] = [];
  private pendingBytes = 0;
  /** Chained append promise — preserves on-disk write order. */
  private writeChain: Promise<void> = Promise.resolve();
  /** Resolves when the currently queued batch has been written. */
  private flushDeferred: { promise: Promise<void>; resolve: () => void } | null = null;
  private dirEnsured: Promise<void> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** append() calls still queueing their line (awaiting ensureDir). */
  private inFlightAppends = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(sessionId: string, options: SessionJsonlOptions = {}) {
    const baseDir = options.baseDir ?? defaultBaseDir();
    this.filePath = path.join(baseDir, `${sessionId}.jsonl`);
    this.onError = options.onError ?? console.error;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  }

  /** Absolute path to the session JSONL file. */
  get path(): string {
    return this.filePath;
  }

  /** Ensure the parent directory exists — once per writer lifetime. */
  private ensureDir(): Promise<void> {
    if (!this.dirEnsured) {
      this.dirEnsured = fs
        .mkdir(path.dirname(this.filePath), { recursive: true })
        .catch((err) => {
          // Allow a later append to retry the mkdir after a failure.
          this.dirEnsured = null;
          throw err;
        });
    }
    return this.dirEnsured;
  }

  /**
   * Queue a BrainEvent as one JSON line. Resolves once the batch containing
   * this event has been written (threshold, cadence, or flush()) — callers
   * on the per-token hot path fire-and-forget instead of awaiting inline.
   */
  async append(event: BrainEvent): Promise<void> {
    // The in-flight window covers only the queueing phase (before any
    // durability wait): flush() must not deadlock on an append that is
    // itself waiting for the flush's drain.
    this.inFlightAppends++;
    let durability: Promise<void> = Promise.resolve();
    try {
      try {
        await this.ensureDir();
        const line =
          JSON.stringify({
            ts: event.ts,
            sessionId: event.sessionId,
            event,
          }) + '\n';
        this.pending.push(line);
        this.pendingBytes += line.length;
        if (
          this.pending.length >= MAX_PENDING_EVENTS ||
          this.pendingBytes >= MAX_PENDING_BYTES
        ) {
          durability = this.drain();
        } else {
          durability = this.scheduleFlush();
        }
      } catch (err) {
        this.onError(`[sessionJsonl] failed to append event to ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      this.inFlightAppends--;
      if (this.inFlightAppends === 0) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const w of waiters) w();
      }
    }
    return durability;
  }

  /** Resolve when no append() is still mid-queueing. */
  private async waitIdle(): Promise<void> {
    while (this.inFlightAppends > 0) {
      await new Promise<void>((r) => this.idleWaiters.push(r));
    }
  }

  /**
   * Arm the cadence timer; resolve when the batch queued so far has been
   * written (not merely when older writes settle).
   */
  private scheduleFlush(): Promise<void> {
    if (this.pending.length > 0 && !this.flushDeferred) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      this.flushDeferred = { promise, resolve };
    }
    if (this.flushTimer === null && this.pending.length > 0) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.drain();
      }, this.flushIntervalMs);
      // Never hold the event loop open just for a pending transcript flush.
      this.flushTimer.unref?.();
    }
    return this.flushDeferred ? this.flushDeferred.promise : this.writeChain;
  }

  /** Write all pending lines in one appendFile, chained in order. */
  private drain(): Promise<void> {
    const settle = () => {
      this.flushDeferred?.resolve();
      this.flushDeferred = null;
    };
    if (this.pending.length === 0) {
      settle();
      return this.writeChain;
    }
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const batch = this.pending.join('');
    this.pending = [];
    this.pendingBytes = 0;
    this.writeChain = this.writeChain
      .then(() => fs.appendFile(this.filePath, batch, { encoding: 'utf-8', mode: 0o644 }))
      .catch((err) => {
        this.onError(`[sessionJsonl] failed to append event to ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(settle);
    return this.writeChain;
  }

  /**
   * Flush any buffered events and resolve when durable. Call at turn boundaries.
   * Waits for in-flight append() calls to finish queueing first, so a flush
   * fired right after an event cannot miss it.
   */
  async flush(): Promise<void> {
    await this.waitIdle();
    await this.drain();
  }

  /** Close the writer: cancel the cadence timer and flush the tail. */
  async close(): Promise<void> {
    await this.flush();
  }
}

/**
 * Read all events from a session JSONL file. Malformed lines are skipped.
 * Returns an empty array if the file does not exist.
 */
export async function readSession(filePath: string): Promise<BrainEvent[]> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const events: BrainEvent[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as { event: BrainEvent };
        if (parsed && typeof parsed === 'object' && 'event' in parsed) {
          events.push(parsed.event);
        }
      } catch {
        // Skip malformed lines silently.
      }
    }
    return events;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** Default base directory: `<userData>/sessions/` (resolved at runtime via electron.app).
 *  In test environments, override via `new SessionJsonlWriter(id, { baseDir: '/tmp/test' })`. */
function defaultBaseDir(): string {
  // We can't import 'electron' here (this module is browser-importable for tests).
  // The caller must pass baseDir explicitly OR we use a sensible fallback.
  // In main process, the AgentHarness caller will pass `<userData>/sessions`.
  return path.join(os.tmpdir(), 'zelari-code', 'sessions');
}
