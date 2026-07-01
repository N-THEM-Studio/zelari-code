/**
 * councilFeedback — persistent feedback store for council members (Task I.2, v3-I).
 *
 * Stores user ratings (1-5) per member across sessions in a JSON file under
 * the user's home directory. Used by `/council-feedback <memberId> <1-5> [note]`
 * to register feedback, and (optionally) by `runCouncilPure` to rank members
 * by historical score.
 *
 * Pure node:fs — no Electron deps, browser-importable for jsdom tests.
 * Env override: `ANATHEMA_COUNCIL_FEEDBACK_FILE` (useful for tests + CI).
 *
 * @see docs/plans/2026-06-29-anathema-coder-v3-I.md (I.2)
 */

import {
  promises as fs,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface FeedbackEntry {
  /** When the feedback was recorded (epoch ms). */
  ts: number;
  /** Member id (e.g. 'charont'). */
  memberId: string;
  /** Score, 1-5 inclusive. */
  score: number;
  /** Optional free-form note from the user. */
  note?: string;
  /** Optional session id for cross-referencing. */
  sessionId?: string;
}

export interface MemberStats {
  memberId: string;
  /** Number of feedback entries for this member. */
  count: number;
  /** Average score (0 when count=0). */
  avg: number;
  /** Most recent feedback timestamp (0 when count=0). */
  lastTs: number;
}

export interface FeedbackStoreOptions {
  /** Override the file path. Useful for tests. */
  file?: string;
  /** Override `now()` for tests. */
  now?: () => number;
}

export class FeedbackStore {
  private readonly file: string;
  private readonly now: () => number;
  private entries: FeedbackEntry[] = [];

  constructor(options: FeedbackStoreOptions = {}) {
    this.file = options.file
      ?? (process.env.ANATHEMA_COUNCIL_FEEDBACK_FILE
        ?? path.join(os.homedir(), '.tmp', 'zelari-code', 'council-feedback.json'));
    this.now = options.now ?? Date.now;
    this.load();
  }

  /**
   * Record a feedback entry. Validates score in [1,5]. Throws on invalid
   * input — caller's job to validate user input first.
   */
  record(input: {
    memberId: string;
    score: number;
    note?: string;
    sessionId?: string;
    ts?: number;
  }): FeedbackEntry {
    if (!input.memberId || input.memberId.trim().length === 0) {
      throw new Error('FeedbackStore.record: memberId is required');
    }
    if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5) {
      throw new Error(
        `FeedbackStore.record: score must be an integer in [1,5], got ${input.score}`,
      );
    }
    const entry: FeedbackEntry = {
      ts: input.ts ?? this.now(),
      memberId: input.memberId.trim(),
      score: input.score,
      ...(input.note ? { note: input.note } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    };
    this.entries.push(entry);
    this.save();
    return entry;
  }

  /** Aggregate stats for one member. Returns defaults (0/0/0) when unknown. */
  getStats(memberId: string): MemberStats {
    const filtered = this.entries.filter((e) => e.memberId === memberId);
    if (filtered.length === 0) {
      return { memberId, count: 0, avg: 0, lastTs: 0 };
    }
    let sum = 0;
    let lastTs = 0;
    for (const e of filtered) {
      sum += e.score;
      if (e.ts > lastTs) lastTs = e.ts;
    }
    return {
      memberId,
      count: filtered.length,
      avg: sum / filtered.length,
      lastTs,
    };
  }

  /** All entries for a member, newest first. */
  getEntries(memberId: string): FeedbackEntry[] {
    return this.entries
      .filter((e) => e.memberId === memberId)
      .sort((a, b) => b.ts - a.ts);
  }

  /**
   * Sort an array of `{id: string}` objects by their feedback score, descending.
   * Members with no feedback are placed at the end, ordered by id ascending
   * (deterministic). Ties broken by count desc, then id asc.
   *
   * Returns a NEW array — does not mutate the input.
   */
  ranked<T extends { id: string }>(items: T[]): T[] {
    const stats = new Map<string, MemberStats>();
    for (const item of items) {
      stats.set(item.id, this.getStats(item.id));
    }
    return [...items].sort((a, b) => {
      const sa = stats.get(a.id)!;
      const sb = stats.get(b.id)!;
      if (sb.avg !== sa.avg) return sb.avg - sa.avg;
      if (sb.count !== sa.count) return sb.count - sa.count;
      return a.id.localeCompare(b.id);
    });
  }

  /**
   * Clear feedback entries. When `memberId` is given, only that member's
   * entries are removed; otherwise the entire store is wiped. Returns the
   * number of entries removed.
   */
  clear(memberId?: string): number {
    const before = this.entries.length;
    if (memberId === undefined) {
      this.entries = [];
    } else {
      this.entries = this.entries.filter((e) => e.memberId !== memberId);
    }
    const removed = before - this.entries.length;
    if (removed > 0) this.save();
    return removed;
  }

  /** All entries, newest first. Useful for `/council-feedback --list`. */
  listAll(): FeedbackEntry[] {
    return [...this.entries].sort((a, b) => b.ts - a.ts);
  }

  // --- persistence ---------------------------------------------------------

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = readFileSync(this.file, 'utf-8');
      const parsed = JSON.parse(raw) as { entries?: FeedbackEntry[] };
      if (parsed && Array.isArray(parsed.entries)) {
        // Defensive: only keep entries with valid shape.
        this.entries = parsed.entries.filter(
          (e) =>
            e
            && typeof e.ts === 'number'
            && typeof e.memberId === 'string'
            && Number.isInteger(e.score)
            && e.score >= 1
            && e.score <= 5,
        );
      }
    } catch {
      // Corrupt file — start fresh. Caller can recover via clear() + re-record.
    }
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(
      this.file,
      JSON.stringify({ entries: this.entries }, null, 2),
      { encoding: 'utf-8', mode: 0o600 },
    );
  }

  /** Async variant of load for callers that prefer async IO. */
  async loadAsync(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf-8');
      const parsed = JSON.parse(raw) as { entries?: FeedbackEntry[] };
      if (parsed && Array.isArray(parsed.entries)) {
        this.entries = parsed.entries.filter(
          (e) =>
            e
            && typeof e.ts === 'number'
            && typeof e.memberId === 'string'
            && Number.isInteger(e.score)
            && e.score >= 1
            && e.score <= 5,
        );
      }
    } catch {
      // ENOENT or JSON parse failure — fall back to in-memory state.
    }
  }
}
