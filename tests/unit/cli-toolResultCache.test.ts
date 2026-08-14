/**
 * cli-toolResultCache.test.ts — WS5 read-only tool-result cache.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { typedOk, type ToolContext, type ToolDefinition } from '@zelari/core/harness/tools/toolTypes';
import {
  withResultCache,
  resetToolResultCache,
  toolResultCacheSize,
  TOOL_CACHE_MAX_ENTRIES,
  TOOL_CACHE_MAX_BYTES,
} from '../../src/cli/toolResultCache.js';

function ctx(cwd: string): ToolContext {
  return {
    cwd,
    signal: new AbortController().signal,
    audit: () => undefined,
    sessionId: 't',
  };
}

function makeReadTool(calls: { n: number }): ToolDefinition<{ path: string }, { content: string }> {
  return {
    name: 'read_file',
    description: 'test read',
    permissions: ['read'],
    inputSchema: z.object({ path: z.string() }),
    execute: async (args) => {
      calls.n += 1;
      const content = await fs.readFile(args.path, 'utf8');
      return typedOk({ content });
    },
  };
}

function makeListTool(calls: { n: number }): ToolDefinition<{ path?: string }, { entries: string[] }> {
  return {
    name: 'list_files',
    description: 'test list',
    permissions: ['read'],
    inputSchema: z.object({ path: z.string().optional() }),
    execute: async (args) => {
      calls.n += 1;
      return typedOk({ entries: [args.path ?? '.'] });
    },
  };
}

describe('withResultCache', () => {
  let tmp: string;
  const prevCache = process.env.ZELARI_TOOL_CACHE;
  const prevTtl = process.env.ZELARI_TOOL_CACHE_TTL;

  beforeEach(async () => {
    resetToolResultCache();
    delete process.env.ZELARI_TOOL_CACHE;
    delete process.env.ZELARI_TOOL_CACHE_TTL;
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-toolcache-'));
  });

  afterEach(async () => {
    resetToolResultCache();
    if (prevCache === undefined) delete process.env.ZELARI_TOOL_CACHE;
    else process.env.ZELARI_TOOL_CACHE = prevCache;
    if (prevTtl === undefined) delete process.env.ZELARI_TOOL_CACHE_TTL;
    else process.env.ZELARI_TOOL_CACHE_TTL = prevTtl;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('hits on a second identical read_file while mtime+size are unchanged', async () => {
    const file = path.join(tmp, 'a.txt');
    await fs.writeFile(file, 'hello');
    const calls = { n: 0 };
    const wrapped = withResultCache(makeReadTool(calls), { kind: 'stat' });
    const first = await wrapped.execute({ path: file }, ctx(tmp));
    const second = await wrapped.execute({ path: file }, ctx(tmp));
    expect(first).toEqual({ ok: true, value: { content: 'hello' } });
    expect(second).toEqual(first);
    expect(calls.n).toBe(1);
  });

  it('misses after the file mtime changes', async () => {
    const file = path.join(tmp, 'b.txt');
    await fs.writeFile(file, 'v1');
    const calls = { n: 0 };
    const wrapped = withResultCache(makeReadTool(calls), { kind: 'stat' });
    await wrapped.execute({ path: file }, ctx(tmp));
    expect(calls.n).toBe(1);
    const st = await fs.stat(file);
    await fs.writeFile(file, 'v2');
    await fs.utimes(file, st.atime, new Date(st.mtimeMs + 2_000));
    const second = await wrapped.execute({ path: file }, ctx(tmp));
    expect(calls.n).toBe(2);
    expect(second).toEqual({ ok: true, value: { content: 'v2' } });
  });

  it('kill switch ZELARI_TOOL_CACHE=0 disables caching', async () => {
    process.env.ZELARI_TOOL_CACHE = '0';
    const file = path.join(tmp, 'c.txt');
    await fs.writeFile(file, 'x');
    const calls = { n: 0 };
    const wrapped = withResultCache(makeReadTool(calls), { kind: 'stat' });
    await wrapped.execute({ path: file }, ctx(tmp));
    await wrapped.execute({ path: file }, ctx(tmp));
    expect(calls.n).toBe(2);
    expect(toolResultCacheSize()).toBe(0);
  });

  it('evicts the oldest entry once the cap is exceeded', async () => {
    const calls = { n: 0 };
    const wrapped = withResultCache(makeListTool(calls), { kind: 'ttl' });
    for (let i = 0; i < TOOL_CACHE_MAX_ENTRIES + 1; i++) {
      await wrapped.execute({ path: `p${i}` }, ctx(tmp));
    }
    expect(toolResultCacheSize()).toBe(TOOL_CACHE_MAX_ENTRIES);
    const afterCap = calls.n;
    // First key was evicted — re-running it should miss.
    await wrapped.execute({ path: 'p0' }, ctx(tmp));
    expect(calls.n).toBe(afterCap + 1);
    // Last key is still cached.
    await wrapped.execute({ path: `p${TOOL_CACHE_MAX_ENTRIES}` }, ctx(tmp));
    expect(calls.n).toBe(afterCap + 1);
  });

  it('does not cache a result larger than 256KB', async () => {
    // Use a non-`content` payload so registry-style truncation does not
    // shrink it under the cap before the size check.
    const entries = Array.from({ length: 8_000 }, (_, i) => `entry-${i}-${'x'.repeat(40)}`);
    const calls = { n: 0 };
    const tool: ToolDefinition<{ path: string }, { entries: string[] }> = {
      name: 'list_files',
      description: 'big',
      permissions: ['read'],
      inputSchema: z.object({ path: z.string() }),
      execute: async () => {
        calls.n += 1;
        return typedOk({ entries });
      },
    };
    const wrapped = withResultCache(tool, { kind: 'ttl' });
    await wrapped.execute({ path: 'huge' }, ctx(tmp));
    await wrapped.execute({ path: 'huge' }, ctx(tmp));
    expect(calls.n).toBe(2);
    expect(toolResultCacheSize()).toBe(0);
  });

  it('expires TTL entries', async () => {
    let now = 1_000;
    const calls = { n: 0 };
    const wrapped = withResultCache(makeListTool(calls), {
      kind: 'ttl',
      now: () => now,
    });
    process.env.ZELARI_TOOL_CACHE_TTL = '50';
    await wrapped.execute({ path: 'd' }, ctx(tmp));
    await wrapped.execute({ path: 'd' }, ctx(tmp));
    expect(calls.n).toBe(1);
    now = 1_060;
    await wrapped.execute({ path: 'd' }, ctx(tmp));
    expect(calls.n).toBe(2);
  });
});
