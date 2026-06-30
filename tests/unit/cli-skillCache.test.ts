/**
 * cli-skillCache.test.ts — Task H.1.2
 *
 * Tests for the persistent JSON skill results cache. Verifies:
 *  - hit/miss semantics
 *  - TTL expiry (with injectable clock)
 *  - per-skill purge + full purge
 *  - inputHash collision safety (different skillId+input producing same
 *    hash is impossible by construction, but we test the delimiter case)
 *  - corruption recovery (unreadable JSON file → fresh cache, no crash)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SkillCache,
  computeInputHash,
  SKILL_CACHE_DEFAULT_TTL_MS,
  readSkillCacheFile,
} from '../../src/cli/skillCache.js';

describe('computeInputHash (Task H.1.2)', () => {
  it('produces a 64-char SHA-256 hex digest', () => {
    const h = computeInputHash('skill-a', 'hello');
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  it('same skillId+input → same hash', () => {
    expect(computeInputHash('a', 'x')).toBe(computeInputHash('a', 'x'));
  });

  it('different skillId → different hash', () => {
    expect(computeInputHash('a', 'x')).not.toBe(computeInputHash('b', 'x'));
  });

  it('different input → different hash', () => {
    expect(computeInputHash('a', 'x')).not.toBe(computeInputHash('a', 'y'));
  });

  it('null-byte delimiter prevents prefix-collision (a+x vs b+y where a="ab"+"")', () => {
    // Without a delimiter, `("ab", "")` would hash to the same prefix as
    // `("a", "b")`. With the null-byte delimiter they must differ.
    const h1 = computeInputHash('ab', '');
    const h2 = computeInputHash('a', 'b');
    expect(h1).not.toBe(h2);
  });
});

describe('SkillCache hit/miss/expiry (Task H.1.2)', () => {
  let dir: string;
  let file: string;
  let cache: SkillCache;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'skill-cache-'));
    file = path.join(dir, 'cache.json');
    cache = new SkillCache({ file });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('miss on empty cache returns null', () => {
    expect(cache.get('skill-a', 'hello')).toBeNull();
  });

  it('set then get returns the stored output', () => {
    cache.set('skill-a', 'hello', { result: 42 });
    expect(cache.get('skill-a', 'hello')).toEqual({ result: 42 });
  });

  it('different inputs to same skill are stored separately', () => {
    cache.set('skill-a', 'input-1', 'out-1');
    cache.set('skill-a', 'input-2', 'out-2');
    expect(cache.get('skill-a', 'input-1')).toBe('out-1');
    expect(cache.get('skill-a', 'input-2')).toBe('out-2');
  });

  it('same input to different skills are stored separately', () => {
    cache.set('skill-a', 'same-input', 'a-out');
    cache.set('skill-b', 'same-input', 'b-out');
    expect(cache.get('skill-a', 'same-input')).toBe('a-out');
    expect(cache.get('skill-b', 'same-input')).toBe('b-out');
  });

  it('overwriting an existing entry replaces the value', () => {
    cache.set('skill-a', 'input', 'first');
    cache.set('skill-a', 'input', 'second');
    expect(cache.get('skill-a', 'input')).toBe('second');
    expect(cache.size()).toBe(1);
  });

  it('entry persists to disk and survives a fresh SkillCache instance', async () => {
    cache.set('skill-a', 'input', 'persisted-value');
    expect(existsSync(file)).toBe(true);

    const freshCache = new SkillCache({ file });
    expect(freshCache.get('skill-a', 'input')).toBe('persisted-value');
  });

  it('expired entry is removed on get + returns null', () => {
    let now = 1000;
    const cacheWithClock = new SkillCache({
      file,
      now: () => now,
      defaultTtlMs: 100,
    });
    cacheWithClock.set('skill-a', 'input', 'short-lived');
    expect(cacheWithClock.get('skill-a', 'input')).toBe('short-lived');

    now += 101; // past TTL
    expect(cacheWithClock.get('skill-a', 'input')).toBeNull();
    expect(cacheWithClock.size()).toBe(0); // expired entry removed eagerly
  });

  it('per-entry ttlMs overrides the default', () => {
    let now = 1000;
    const cacheWithClock = new SkillCache({
      file,
      now: () => now,
      defaultTtlMs: 1000,
    });
    cacheWithClock.set('skill-a', 'long', 'value', 5000); // 5s override
    cacheWithClock.set('skill-a', 'short', 'value', 100); // 0.1s override

    now += 200; // past short's TTL, not past long's
    expect(cacheWithClock.get('skill-a', 'short')).toBeNull();
    expect(cacheWithClock.get('skill-a', 'long')).toBe('value');
  });

  it('default TTL is 24h when not overridden', () => {
    expect(SKILL_CACHE_DEFAULT_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('SkillCache clearExpired + purge (Task H.1.2)', () => {
  let dir: string;
  let file: string;
  let now: number;
  let cache: SkillCache;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'skill-cache-'));
    file = path.join(dir, 'cache.json');
    now = 1_000_000;
    cache = new SkillCache({ file, now: () => now, defaultTtlMs: 1000 });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('clearExpired removes only expired entries, leaves fresh ones', () => {
    cache.set('a', 'x', '1'); // expires at now+1000 = 1001000
    cache.set('b', 'y', '2'); // expires at now+1000 = 1001000

    now += 500; // both still fresh
    expect(cache.clearExpired()).toBe(0);

    now += 600; // now=1100 past first expiry → both expired
    const removed = cache.clearExpired();
    expect(removed).toBe(2);
    expect(cache.size()).toBe(0);
  });

  it('purge(skillId) removes only entries for that skill', () => {
    cache.set('a', 'x', '1');
    cache.set('a', 'y', '2');
    cache.set('b', 'z', '3');
    expect(cache.size()).toBe(3);

    const removed = cache.purge('a');
    expect(removed).toBe(2);
    expect(cache.size()).toBe(1);
    expect(cache.get('b', 'z')).toBe('3');
  });

  it('purge() with no arg wipes the whole cache', () => {
    cache.set('a', 'x', '1');
    cache.set('b', 'y', '2');
    cache.set('c', 'z', '3');

    const removed = cache.purge();
    expect(removed).toBe(3);
    expect(cache.size()).toBe(0);
  });

  it('purge on non-existent skill is a no-op returning 0', () => {
    cache.set('a', 'x', '1');
    expect(cache.purge('nonexistent')).toBe(0);
    expect(cache.size()).toBe(1);
  });
});

describe('SkillCache corruption recovery (Task H.1.2)', () => {
  it('unreadable JSON file → fresh cache, no crash', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'skill-cache-corrupt-'));
    const file = path.join(dir, 'cache.json');
    try {
      // Write invalid JSON
      require('node:fs').writeFileSync(file, 'not valid json {{{', 'utf-8');

      const cache = new SkillCache({ file });
      expect(cache.get('any', 'input')).toBeNull();
      // Should be usable after corruption
      cache.set('any', 'input', 'recovered');
      expect(cache.get('any', 'input')).toBe('recovered');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('missing file → fresh cache + creates file on first set', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'skill-cache-missing-'));
    const file = path.join(dir, 'cache.json');
    try {
      expect(existsSync(file)).toBe(false);
      const cache = new SkillCache({ file });
      cache.set('a', 'x', 1);
      expect(existsSync(file)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readSkillCacheFile helper (Task H.1.2)', () => {
  it('returns parsed object when file is valid', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'skill-cache-read-'));
    const file = path.join(dir, 'cache.json');
    try {
      const cache = new SkillCache({ file });
      cache.set('a', 'x', { hello: 'world' });
      const result = await readSkillCacheFile(file);
      expect(result).not.toBeNull();
      expect(result?.version).toBe(1);
      const key = computeInputHash('a', 'x');
      expect(result?.entries[key]?.output).toEqual({ hello: 'world' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when file is missing', async () => {
    const file = path.join(tmpdir(), 'definitely-not-existing-' + Date.now() + '.json');
    const result = await readSkillCacheFile(file);
    expect(result).toBeNull();
  });
});
