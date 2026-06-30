/**
 * metrics — JSONL metrics logger (Task B.5).
 *
 * Append-only NDJSON writer for runtime telemetry. One event per line,
 * flushed via fire-and-forget queue (matches auditLogger pattern from
 * v3-A).
 *
 * Schema (per record):
 *   {
 *     ts: number,          // epoch ms
 *     kind: 'run' | 'message' | 'error',
 *     sessionId?: string,
 *     provider?: string,
 *     model?: string,
 *     latencyMs?: number,
 *     tokens?: number,
 *     costUsd?: number,
 *     ok?: boolean,
 *     error?: string,
 *   }
 *
 * Storage: `~/.tmp/anathema-coder/metrics.jsonl` (override via
 * `ANATHEMA_METRICS_FILE` env var, useful for tests).
 *
 * Rotation: when the file exceeds 10MB, it's renamed to
 * `metrics.1.jsonl` (existing `.1.jsonl` is overwritten). Only one
 * rotation step — older data is dropped. This matches typical
 * logrotate setups.
 */

import { promises as fs, existsSync, statSync, renameSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const METRICS_ROTATE_BYTES = 10 * 1024 * 1024; // 10 MB

export type MetricsKind = 'run' | 'message' | 'error' | 'tool';

export interface MetricsRecord {
  ts: number;
  kind: MetricsKind;
  sessionId?: string;
  provider?: string;
  model?: string;
  latencyMs?: number;
  tokens?: number;
  costUsd?: number;
  ok?: boolean;
  error?: string;
  /** Tool name (for `kind: 'tool'` records, Task G.3). */
  toolName?: string;
  /** Tool call id (for `kind: 'tool'` records). */
  toolCallId?: string;
}

export class MetricsLogger {
  private readonly file: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(file?: string) {
    this.file = file ?? process.env.ANATHEMA_METRICS_FILE
      ?? path.join(os.homedir(), '.tmp', 'anathema-coder', 'metrics.jsonl');
    mkdirSync(path.dirname(this.file), { recursive: true });
  }

  /** Fire-and-forget record append. */
  record(rec: Omit<MetricsRecord, 'ts'> & { ts?: number }): void {
    const full: MetricsRecord = { ts: rec.ts ?? Date.now(), ...rec };
    this.writeQueue = this.writeQueue.then(() => this.append(full));
    void this.writeQueue.catch(() => {/* swallow — fire-and-forget */});
  }

  /** Append a single record synchronously (file I/O). */
  private append(rec: MetricsRecord): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        this.maybeRotate();
        const line = JSON.stringify(rec) + '\n';
        appendFileSync(this.file, line, { encoding: 'utf-8' });
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Force the write queue to flush — used by tests + on graceful shutdown.
   * Returns the underlying promise so callers can await it.
   */
  async flush(): Promise<void> {
    await this.writeQueue;
  }

  /** If the file is over the rotation threshold, rotate it. */
  private maybeRotate(): void {
    if (!existsSync(this.file)) return;
    try {
      const stat = statSync(this.file);
      if (stat.size >= METRICS_ROTATE_BYTES) {
        const rotated = this.file.replace(/\.jsonl$/, '.1.jsonl');
        renameSync(this.file, rotated);
      }
    } catch {
      // Best-effort.
    }
  }
}

/** Convenience helper for tests: read all records from a metrics file. */
export async function readMetrics(file: string): Promise<MetricsRecord[]> {
  let raw = '';
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch {
    return [];
  }
  const out: MetricsRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as MetricsRecord);
    } catch {
      // Skip malformed lines.
    }
  }
  return out;
}

/**
 * Process-wide singleton MetricsLogger (Task G.3.3). Multiple consumers
 * (the chat session in `app.tsx`, the shutdown handler in `main.ts`)
 * need to coordinate on a single writer so SIGINT/SIGTERM can flush
 * the pending fire-and-forget queue before `process.exit(0)` discards
 * anything still in memory.
 *
 * Lazy-instantiated on first access. Respects the same env override as
 * the constructor (`ANATHEMA_METRICS_FILE`), so tests can point it at
 * a temp file before any consumer imports it.
 *
 * @see docs/plans/2026-06-29-anathema-coder-v3-G.md (Task G.3.3)
 */
let _singleton: MetricsLogger | null = null;
export function getMetricsLogger(): MetricsLogger {
  if (!_singleton) {
    _singleton = new MetricsLogger();
  }
  return _singleton;
}

/** Reset the singleton (test-only). Forces a fresh instance on next getMetricsLogger(). */
export function resetMetricsLogger(): void {
  _singleton = null;
}