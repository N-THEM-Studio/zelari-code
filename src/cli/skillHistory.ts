/**
 * skillHistory — JSONL skill invocation history (Phase 25 — Skill History + Telemetry).
 *
 * Tracks every invocation of `/skill <name>` so the user can later query
 * success rate + duration + token usage via `/skill-stats [name]`.
 *
 * Schema (per record):
 *   {
 *     ts: number,           // epoch ms when invocation ended
 *     skillId: string,      // e.g. 'coder-debug', 'brain-memory'
 *     invocationId: string, // unique per recordStart() call
 *     sessionId?: string,
 *     durationMs?: number,  // wall-clock from recordStart to recordEnd
 *     tokensUsed?: number,  // optional — caller-supplied
 *     ok: boolean,          // true on success, false on error
 *     error?: string,       // error message when ok=false
 *   }
 *
 * Storage: `~/.tmp/anathema-coder/skill-history.jsonl` (override via
 * `ANATHEMA_SKILL_HISTORY_FILE` env var, useful for tests).
 *
 * Rotation: when the file exceeds 10MB, it's renamed to
 * `skill-history.1.jsonl` (existing `.1.jsonl` is overwritten). Only one
 * rotation step — older data is dropped. Same pattern as metrics.ts.
 *
 * Privacy: only metadata is stored (skillId, duration, ok). No prompt
 * content or model outputs are persisted by this logger.
 */

import { promises as fs, existsSync, statSync, renameSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export const SKILL_HISTORY_ROTATE_BYTES = 10 * 1024 * 1024; // 10 MB

export interface SkillHistoryRecord {
  ts: number;
  skillId: string;
  invocationId: string;
  sessionId?: string;
  durationMs?: number;
  tokensUsed?: number;
  ok: boolean;
  error?: string;
}

/**
 * Aggregated stats for a single skill (or for all skills when skillId is omitted).
 * All fields default to 0 when count is 0.
 */
export interface SkillStats {
  count: number;
  successRate: number; // 0..1; 0 when count is 0
  avgDurationMs: number;
  totalTokens: number;
}

/**
 * In-flight invocation context (stored between recordStart + recordEnd).
 * Held in memory only — not persisted until recordEnd is called.
 */
interface InflightInvocation {
  ts: number;
  skillId: string;
  sessionId?: string;
}

export class SkillHistoryLogger {
  private readonly file: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly inflight = new Map<string, InflightInvocation>();

  constructor(file?: string) {
    this.file = file ?? process.env.ANATHEMA_SKILL_HISTORY_FILE
      ?? path.join(os.homedir(), '.tmp', 'anathema-coder', 'skill-history.jsonl');
    mkdirSync(path.dirname(this.file), { recursive: true });
  }

  /**
   * Mark the start of a skill invocation. Returns a unique invocationId
   * that the caller must pass to `recordEnd` when the invocation completes.
   *
   * Multiple concurrent invocations are supported (one inflight entry per id).
   */
  recordStart(skillId: string, sessionId?: string): string {
    const invocationId = randomUUID();
    this.inflight.set(invocationId, { ts: Date.now(), skillId, sessionId });
    return invocationId;
  }

  /**
   * Mark the end of a skill invocation. Writes a SkillHistoryRecord to disk.
   *
   * If `invocationId` is unknown (e.g. duplicate call or logger recreated),
   * this is a no-op. The logger never throws from recordEnd — it's safe
   * to call from finally blocks.
   */
  recordEnd(
    invocationId: string,
    outcome: { ok: boolean; tokensUsed?: number; error?: string },
  ): void {
    const start = this.inflight.get(invocationId);
    if (!start) return; // unknown id — graceful no-op
    this.inflight.delete(invocationId);
    const rec: SkillHistoryRecord = {
      ts: Date.now(),
      skillId: start.skillId,
      invocationId,
      sessionId: start.sessionId,
      durationMs: Date.now() - start.ts,
      tokensUsed: outcome.tokensUsed,
      ok: outcome.ok,
      error: outcome.error,
    };
    this.writeQueue = this.writeQueue.then(() => this.append(rec));
    void this.writeQueue.catch(() => {/* swallow — fire-and-forget */});
  }

  /**
   * Force the write queue to flush — used by tests + on graceful shutdown.
   * Returns the underlying promise so callers can await it.
   */
  async flush(): Promise<void> {
    await this.writeQueue;
  }

  /** Number of in-flight invocations (mostly for tests). */
  inflightCount(): number {
    return this.inflight.size;
  }

  /** Append a single record synchronously (file I/O). */
  private append(rec: SkillHistoryRecord): Promise<void> {
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

  /** If the file is over the rotation threshold, rotate it. */
  private maybeRotate(): void {
    if (!existsSync(this.file)) return;
    try {
      const stat = statSync(this.file);
      if (stat.size >= SKILL_HISTORY_ROTATE_BYTES) {
        const rotated = this.file.replace(/\.jsonl$/, '.1.jsonl');
        renameSync(this.file, rotated);
      }
    } catch {
      // Best-effort.
    }
  }
}

/** Convenience helper: read all records from a skill history file. */
export async function readSkillHistory(file: string): Promise<SkillHistoryRecord[]> {
  let raw = '';
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch {
    return [];
  }
  const out: SkillHistoryRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as SkillHistoryRecord);
    } catch {
      // Skip malformed lines.
    }
  }
  return out;
}

/**
 * Compute aggregated stats over a list of records.
 *
 * Pure function — no file I/O. Caller reads the file with readSkillHistory()
 * and passes the records here.
 *
 * @param records — full record list (already loaded from disk)
 * @param skillId — optional filter: only stats for this skill
 * @param sinceTs — optional filter: only records with ts >= sinceTs
 */
export function getSkillStats(
  records: SkillHistoryRecord[],
  skillId?: string,
  sinceTs?: number,
): SkillStats {
  const filtered = records.filter((r) => {
    if (skillId !== undefined && r.skillId !== skillId) return false;
    if (sinceTs !== undefined && r.ts < sinceTs) return false;
    return true;
  });
  if (filtered.length === 0) {
    return { count: 0, successRate: 0, avgDurationMs: 0, totalTokens: 0 };
  }
  const successCount = filtered.filter((r) => r.ok).length;
  const durations = filtered
    .map((r) => r.durationMs)
    .filter((d): d is number => typeof d === 'number');
  const avgDurationMs = durations.length === 0
    ? 0
    : durations.reduce((a, b) => a + b, 0) / durations.length;
  const totalTokens = filtered.reduce((sum, r) => sum + (r.tokensUsed ?? 0), 0);
  return {
    count: filtered.length,
    successRate: successCount / filtered.length,
    avgDurationMs,
    totalTokens,
  };
}