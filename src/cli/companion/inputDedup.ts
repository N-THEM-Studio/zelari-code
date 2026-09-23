/**
 * companion/inputDedup.ts — persistent input dedup for companion runs.
 *
 * Prevents duplicate runs when mobile clients reconnect and re-submit the same
 * request. Each input carries an optional `idempotencyKey` (client-generated
 * stable ID). If a key was already processed, the store returns the cached
 * run ID so the client gets the same result without spawning a new run.
 *
 * Persistence: a JSON file at `~/.zelari-code/input-dedup.json`. Entries
 * expire after a configurable TTL (default 24 h). The store is loaded on
 * first access and flushed on every mutation.
 *
 * @see .zelari/docs/2026-09-21-piano-roi-steal-unreal-agent.md §A5
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { getZelariHome } from './config.js';

export const DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

interface DedupEntry {
  runId: string;
  createdAt: number;
}

type DedupStoreData = Record<string, DedupEntry>;

function dedupPath(): string {
  return join(getZelariHome(), 'input-dedup.json');
}

/**
 * Persistent idempotency store for companion input.
 *
 * Thread-safe for single-process Node: all mutations are synchronous after
 * the initial async load. The file is flushed atomically (write-then-rename
 * is not needed for this low-frequency path — a plain write suffices).
 */
export class InputDedupStore {
  private data: DedupStoreData = {};
  private loaded = false;
  private readonly ttlMs: number;
  private readonly filePath: string;

  constructor(opts?: { ttlMs?: number; filePath?: string }) {
    this.ttlMs = opts?.ttlMs ?? DEDUP_TTL_MS;
    this.filePath = opts?.filePath ?? dedupPath();
  }

  /** Load the store from disk (no-op if already loaded). */
  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as DedupStoreData;
      if (parsed && typeof parsed === 'object') {
        this.data = parsed;
      }
    } catch {
      // File missing or corrupt — start fresh.
    }
    this.loaded = true;
    this.evictExpired();
  }

  /** Look up an idempotency key. Returns the runId if found and not expired. */
  get(key: string): string | undefined {
    const entry = this.data[key];
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > this.ttlMs) {
      delete this.data[key];
      return undefined;
    }
    return entry.runId;
  }

  /** Record a new idempotency key → runId mapping. Flushes to disk. */
  async set(key: string, runId: string): Promise<void> {
    this.data[key] = { runId, createdAt: Date.now() };
    this.evictExpired();
    await this.flush();
  }

  /** Check if a key exists (without returning the value). */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** Remove expired entries in-memory. */
  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of Object.entries(this.data)) {
      if (now - entry.createdAt > this.ttlMs) {
        delete this.data[key];
      }
    }
  }

  /** Persist the current state to disk. */
  private async flush(): Promise<void> {
    try {
      await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch {
      // Best-effort: if we can't write, dedup degrades to in-memory only.
    }
  }
}
