/**
 * skillCache — persistent JSON cache for skill invocation results (Task H.1).
 *
 * Avoids re-running a skill on identical input within the TTL window.
 * Built directly on top of the v3-C `skillHistory.ts` telemetry:
 *  - skillHistory records WHAT ran + success rate (for stats + ranking)
 *  - skillCache stores the OUTPUT of past invocations (for instant replay)
 *
 * Privacy: only the SHA-256 of `skillId + '\0' + input` is used as the
 * cache key. The `output` IS persisted (it's the whole point), but the
 * raw `input` string is NOT — so reading the cache file alone never
 * reveals user prompts. This matches v3-C's privacy stance for the
 * history log.
 *
 * Storage: `~/.tmp/anathema-coder/skill-cache.json` (override via
 * `ANATHEMA_SKILL_CACHE_FILE` env var). Bounded size: callers should
 * purge periodically; the file grows by entry size, no rotation.
 *
 * Thread-safety: Node.js is single-threaded for JS execution. File
 * reads/writes are atomic-enough for our needs (the OS doesn't interleave
 * a `readFile` and `writeFile` of a small JSON file in any meaningful
 * way). For multi-process safety, callers should wrap with flock(2)
 * — out of scope for now.
 *
 * @see docs/plans/2026-06-29-anathema-coder-v3-H.md (Task H.1)
 */

import { promises as fs, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

export const SKILL_CACHE_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

interface SkillCacheEntry {
  skillId: string;
  inputHash: string;
  output: unknown;
  ts: number;
  expiresAt: number;
}

interface SkillCacheFile {
  /** Schema version for future migrations. */
  version: 1;
  /** Hash → entry. */
  entries: Record<string, SkillCacheEntry>;
}

/**
 * Compute the SHA-256 cache key for a `(skillId, input)` pair. The
 * null-byte delimiter prevents `id1+input2` from colliding with
 * `id2+input1` (e.g. `("a", "bc")` vs `("ab", "c")`).
 *
 * Exported for testing — production code should not call this directly.
 */
export function computeInputHash(skillId: string, input: string): string {
  return createHash('sha256').update(skillId + '\0' + input, 'utf8').digest('hex');
}

export interface SkillCacheOptions {
  /** File path. Defaults to env `ANATHEMA_SKILL_CACHE_FILE` then `~/.tmp/anathema-coder/skill-cache.json`. */
  file?: string;
  /** Default TTL in ms for entries without an explicit expiresAt. Default 24h. */
  defaultTtlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * Persistent JSON cache for skill invocation results. Lazy-loaded on
 * first access, saved on every mutation.
 */
export class SkillCache {
  private readonly file: string;
  private readonly defaultTtlMs: number;
  private readonly now: () => number;
  private state: SkillCacheFile | null = null;

  constructor(options: SkillCacheOptions = {}) {
    this.file = options.file ?? process.env.ANATHEMA_SKILL_CACHE_FILE
      ?? path.join(os.homedir(), '.tmp', 'zelari-code', 'skill-cache.json');
    this.defaultTtlMs = options.defaultTtlMs ?? SKILL_CACHE_DEFAULT_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    mkdirSync(path.dirname(this.file), { recursive: true });
  }

  /**
   * Look up a cached output for `(skillId, input)`. Returns null on
   * miss OR on expired entry (the expired entry is removed eagerly
   * to keep the file small).
   */
  get(skillId: string, input: string): unknown | null {
    const entry = this.lookupEntry(skillId, input);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      // Expired — remove eagerly
      const key = computeInputHash(skillId, input);
      this.mutate((s) => {
        delete s.entries[key];
      });
      return null;
    }
    return entry.output;
  }

  /**
   * Store an output for `(skillId, input)`. Optional `ttlMs` overrides
   * the cache default for this entry (e.g. short-lived outputs can use
   * 5min; long-lived deterministic ones can use 7 days).
   */
  set(skillId: string, input: string, output: unknown, ttlMs?: number): void {
    const key = computeInputHash(skillId, input);
    const ts = this.now();
    const ttl = ttlMs ?? this.defaultTtlMs;
    const entry: SkillCacheEntry = {
      skillId,
      inputHash: key,
      output,
      ts,
      expiresAt: ts + ttl,
    };
    this.mutate((s) => {
      s.entries[key] = entry;
    });
  }

  /**
   * Remove all expired entries. Returns the count of removed entries.
   * Useful as a periodic maintenance call (e.g. from main.ts shutdown
   * handler).
   */
  clearExpired(): number {
    const now = this.now();
    let removed = 0;
    this.mutate((s) => {
      for (const [key, entry] of Object.entries(s.entries)) {
        if (entry.expiresAt <= now) {
          delete s.entries[key];
          removed++;
        }
      }
    });
    return removed;
  }

  /**
   * Remove all entries for a specific skill (when `skillId` is given),
   * or wipe the entire cache (when omitted). Returns the count of
   * removed entries.
   */
  purge(skillId?: string): number {
    let removed = 0;
    this.mutate((s) => {
      if (skillId === undefined) {
        removed = Object.keys(s.entries).length;
        s.entries = {};
        return;
      }
      for (const [key, entry] of Object.entries(s.entries)) {
        if (entry.skillId === skillId) {
          delete s.entries[key];
          removed++;
        }
      }
    });
    return removed;
  }

  /** Number of entries currently in the cache (useful for tests + CLI status). */
  size(): number {
    return this.loadIfNeeded().entries ? Object.keys(this.loadIfNeeded().entries).length : 0;
  }

  /** Lazy-load the cache file. Idempotent. */
  private loadIfNeeded(): SkillCacheFile {
    if (this.state !== null) return this.state;
    if (!existsSync(this.file)) {
      this.state = { version: 1, entries: {} };
      return this.state;
    }
    try {
      const raw = readFileSync(this.file, 'utf-8');
      const parsed = JSON.parse(raw) as SkillCacheFile;
      // Defensive: ensure shape matches expected schema.
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        parsed.version !== 1 ||
        typeof parsed.entries !== 'object' ||
        parsed.entries === null
      ) {
        this.state = { version: 1, entries: {} };
        return this.state;
      }
      this.state = parsed;
      return this.state;
    } catch {
      // Corrupt or unreadable — start fresh, don't crash the CLI.
      this.state = { version: 1, entries: {} };
      return this.state;
    }
  }

  /** Look up the entry without mutating state (used by get + tests). */
  private lookupEntry(skillId: string, input: string): SkillCacheEntry | null {
    const state = this.loadIfNeeded();
    const key = computeInputHash(skillId, input);
    return state.entries[key] ?? null;
  }

  /** Run `fn` on the in-memory state, then persist to disk. */
  private mutate(fn: (state: SkillCacheFile) => void): void {
    const state = this.loadIfNeeded();
    fn(state);
    this.save(state);
  }

  /** Persist the in-memory state to disk. Synchronous to keep ordering simple. */
  private save(state: SkillCacheFile): void {
    writeFileSync(this.file, JSON.stringify(state), { encoding: 'utf-8' });
  }

  /** Reset in-memory state (test-only helper). */
  resetForTests(): void {
    this.state = null;
  }
}

/**
 * Convenience: try async file-based access. Useful for tests that want
 * to verify the file was written. Most production callers use the
 * `SkillCache` class above (synchronous API for simplicity).
 */
export async function readSkillCacheFile(file: string): Promise<SkillCacheFile | null> {
  try {
    const raw = await fs.readFile(file, 'utf-8');
    return JSON.parse(raw) as SkillCacheFile;
  } catch {
    return null;
  }
}
