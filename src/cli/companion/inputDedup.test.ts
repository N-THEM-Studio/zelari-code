/**
 * Unit tests — input dedup store (A5: idempotenti).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { InputDedupStore, DEDUP_TTL_MS } from './inputDedup.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function tmpFile(): string {
  return join(tmpdir(), `dedup-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

describe('InputDedupStore', () => {
  let filePath: string;

  beforeEach(() => {
    filePath = tmpFile();
  });

  afterEach(async () => {
    try { await fs.unlink(filePath); } catch { /* ignore */ }
  });

  it('returns undefined for unknown key', async () => {
    const store = new InputDedupStore({ filePath });
    await store.load();
    expect(store.get('unknown')).toBeUndefined();
  });

  it('stores and retrieves a key', async () => {
    const store = new InputDedupStore({ filePath });
    await store.load();
    await store.set('key1', 'run-abc');
    expect(store.get('key1')).toBe('run-abc');
  });

  it('has() returns true for stored key', async () => {
    const store = new InputDedupStore({ filePath });
    await store.load();
    await store.set('key1', 'run-abc');
    expect(store.has('key1')).toBe(true);
    expect(store.has('key2')).toBe(false);
  });

  it('persists across store instances (simulates restart)', async () => {
    const store1 = new InputDedupStore({ filePath });
    await store1.load();
    await store1.set('key1', 'run-abc');

    // New instance = simulates restart
    const store2 = new InputDedupStore({ filePath });
    await store2.load();
    expect(store2.get('key1')).toBe('run-abc');
  });

  it('evicts expired entries', async () => {
    const store = new InputDedupStore({ filePath, ttlMs: 100 });
    await store.load();
    await store.set('key1', 'run-abc');

    // Advance time past TTL
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 150);
    expect(store.get('key1')).toBeUndefined();
    vi.useRealTimers();
  });

  it('does not evict unexpired entries', async () => {
    const store = new InputDedupStore({ filePath, ttlMs: 10_000 });
    await store.load();
    await store.set('key1', 'run-abc');

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5000);
    expect(store.get('key1')).toBe('run-abc');
    vi.useRealTimers();
  });

  it('load() is idempotent (no double-read)', async () => {
    const store = new InputDedupStore({ filePath });
    await store.load();
    await store.set('key1', 'run-abc');
    await store.load(); // should not overwrite
    expect(store.get('key1')).toBe('run-abc');
  });

  it('handles corrupt file gracefully', async () => {
    await fs.writeFile(filePath, 'not json!!!', 'utf-8');
    const store = new InputDedupStore({ filePath });
    await store.load();
    expect(store.get('any')).toBeUndefined();
    // Should still be able to write
    await store.set('key1', 'run-abc');
    expect(store.get('key1')).toBe('run-abc');
  });

  it('handles missing file gracefully', async () => {
    const store = new InputDedupStore({ filePath: '/nonexistent/path/dedup.json' });
    await store.load();
    expect(store.get('any')).toBeUndefined();
  });

  it('overwrites existing key with new runId', async () => {
    const store = new InputDedupStore({ filePath });
    await store.load();
    await store.set('key1', 'run-abc');
    await store.set('key1', 'run-def');
    expect(store.get('key1')).toBe('run-def');
  });
});
