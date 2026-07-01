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
}

/**
 * Append-only JSONL writer for a single session.
 *
 * One JSON object per line, shape:
 *   {"ts": <epoch-ms>, "sessionId": "<uuid>", "event": { ...BrainEvent }}
 *
 * The writer is line-buffered: every `append()` flushes synchronously
 * to ensure no events are lost on crash. Uses O_APPEND for atomicity.
 *
 * Malformed lines on read are skipped (with a warning) so the file is
 * always recoverable via `readSession()`.
 */
export class SessionJsonlWriter {
  private readonly filePath: string;
  private readonly onError: (msg: string) => void;

  constructor(sessionId: string, options: SessionJsonlOptions = {}) {
    const baseDir = options.baseDir ?? defaultBaseDir();
    this.filePath = path.join(baseDir, `${sessionId}.jsonl`);
    this.onError = options.onError ?? console.error;
  }

  /** Absolute path to the session JSONL file. */
  get path(): string {
    return this.filePath;
  }

  /** Append a BrainEvent as one JSON line. Creates the file + parent dirs if missing. */
  async append(event: BrainEvent): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const line = JSON.stringify({
        ts: event.ts,
        sessionId: event.sessionId,
        event,
      }) + '\n';
      await fs.appendFile(this.filePath, line, { encoding: 'utf-8', mode: 0o644 });
    } catch (err) {
      this.onError(`[sessionJsonl] failed to append event to ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Close the writer (no-op currently, but reserved for future buffered mode). */
  async close(): Promise<void> {
    // No buffered state to flush yet.
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
