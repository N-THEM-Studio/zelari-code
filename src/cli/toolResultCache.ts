/**
 * toolResultCache — in-process cache for read-only builtin tool results.
 *
 * Applied in `createBuiltinToolRegistry` to read_file / grep_content /
 * list_files so repeated observe calls in the same turn (and across turns
 * while the process lives) skip the underlying I/O.
 *
 * Keys:
 *   - read_file: sha256(tool + args + mtimeMs + size) — auto-invalidates
 *     when the file changes on disk.
 *   - grep_content / list_files: sha256(tool + args + cwd) with a short TTL
 *     (default 5 min, `ZELARI_TOOL_CACHE_TTL` milliseconds).
 *
 * Guards: kill switch `ZELARI_TOOL_CACHE=0`, max 200 entries (evict oldest
 * by ts), skip a single result larger than 256KB. Errors are never cached.
 * Cached payload is the post-truncation form the registry would recompute.
 *
 * Zero new dependencies; file stays well under the 300 LOC convention.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { truncateToolResult } from '@zelari/core/harness/tools/registry';
import type {
  ToolContext,
  ToolDefinition,
  TypedResult,
} from '@zelari/core/harness/tools/toolTypes';

export const TOOL_CACHE_MAX_ENTRIES = 200;
export const TOOL_CACHE_MAX_BYTES = 256 * 1024;
export const TOOL_CACHE_DEFAULT_TTL_MS = 5 * 60 * 1000;

export type ToolCacheKind = 'stat' | 'ttl';

interface CacheEntry {
  result: TypedResult<unknown>;
  ts: number;
  expiresAt?: number;
}

const store = new Map<string, CacheEntry>();

export function isToolCacheEnabled(): boolean {
  const raw = process.env.ZELARI_TOOL_CACHE;
  return raw !== '0' && raw !== 'false' && raw !== 'off';
}

export function resolveToolCacheTtlMs(): number {
  const raw = process.env.ZELARI_TOOL_CACHE_TTL;
  const n = raw ? Number.parseInt(raw, 10) : TOOL_CACHE_DEFAULT_TTL_MS;
  return Number.isFinite(n) && n >= 0 ? n : TOOL_CACHE_DEFAULT_TTL_MS;
}

export function resetToolResultCache(): void {
  store.clear();
}

export function toolResultCacheSize(): number {
  return store.size;
}

function hashKey(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}

function resultBytes(result: TypedResult<unknown>): number {
  try {
    return Buffer.byteLength(JSON.stringify(result), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function cloneResult<T>(result: TypedResult<T>): TypedResult<T> | null {
  try {
    return structuredClone(result);
  } catch {
    return null;
  }
}

function applyTruncation<O>(result: TypedResult<O>, toolName: string): TypedResult<O> {
  if (!result.ok) return result;
  if (typeof result.value === 'string') {
    return {
      ok: true,
      value: truncateToolResult(result.value, { toolName, spill: false }) as O,
    };
  }
  if (result.value && typeof result.value === 'object') {
    const v = result.value as Record<string, unknown>;
    if (typeof v.content === 'string') {
      return {
        ok: true,
        value: {
          ...v,
          content: truncateToolResult(v.content, { toolName, spill: false }),
        } as O,
      };
    }
  }
  return result;
}

function evictOldest(): void {
  let oldestKey: string | null = null;
  let oldestTs = Infinity;
  for (const [key, entry] of store) {
    if (entry.ts < oldestTs) {
      oldestTs = entry.ts;
      oldestKey = key;
    }
  }
  if (oldestKey) store.delete(oldestKey);
}

function cacheGet(key: string, now: number): TypedResult<unknown> | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
    store.delete(key);
    return null;
  }
  return cloneResult(entry.result) ?? entry.result;
}

function cachePut(
  key: string,
  result: TypedResult<unknown>,
  now: number,
  ttlMs?: number,
): void {
  if (!result.ok) return;
  if (resultBytes(result) > TOOL_CACHE_MAX_BYTES) return;
  const cloned = cloneResult(result);
  if (!cloned) return;
  if (store.size >= TOOL_CACHE_MAX_ENTRIES && !store.has(key)) evictOldest();
  store.set(key, {
    result: cloned,
    ts: now,
    ...(ttlMs !== undefined ? { expiresAt: now + ttlMs } : {}),
  });
}

async function statKey(
  toolName: string,
  input: unknown,
  ctx: ToolContext,
): Promise<string | null> {
  if (!input || typeof input !== 'object') return null;
  const rawPath = (input as { path?: unknown }).path;
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null;
  const abs = path.isAbsolute(rawPath) ? rawPath : path.join(ctx.cwd, rawPath);
  try {
    const st = await fs.stat(abs);
    return hashKey({
      tool: toolName,
      args: input,
      mtimeMs: st.mtimeMs,
      size: st.size,
    });
  } catch {
    return null;
  }
}

function ttlKey(toolName: string, input: unknown, cwd: string): string {
  return hashKey({ tool: toolName, args: input, cwd });
}

export interface ResultCacheOptions {
  kind?: ToolCacheKind;
  now?: () => number;
}

/**
 * Wrap a read-only tool so identical invocations reuse the last result.
 * Identity wrapper when `ZELARI_TOOL_CACHE=0`.
 */
export function withResultCache<I, O>(
  tool: ToolDefinition<I, O>,
  options: ResultCacheOptions = {},
): ToolDefinition<I, O> {
  const kind: ToolCacheKind =
    options.kind ?? (tool.name === 'read_file' ? 'stat' : 'ttl');
  const nowFn = options.now ?? Date.now;

  return {
    ...tool,
    execute: async (input: I, ctx: ToolContext): Promise<TypedResult<O>> => {
      if (!isToolCacheEnabled()) return tool.execute(input, ctx);

      const key =
        kind === 'stat'
          ? await statKey(tool.name, input, ctx)
          : ttlKey(tool.name, input, ctx.cwd);
      if (!key) return tool.execute(input, ctx);

      const hit = cacheGet(key, nowFn());
      if (hit) return hit as TypedResult<O>;

      const raw = await tool.execute(input, ctx);
      const stored = applyTruncation(raw, tool.name);
      cachePut(key, stored, nowFn(), kind === 'ttl' ? resolveToolCacheTtlMs() : undefined);
      return stored;
    },
  };
}
