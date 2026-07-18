/**
 * Async durable HEAD materialization — single entry for all dispatch modes.
 *
 * Prefer this over composeContext's sync fallback so agent/council/zelari/headless
 * share the same text shape as FileDurableStateStore.materializeContext().
 *
 * Short process-local cache avoids double I/O when compose runs multiple times
 * in the same turn (e.g. council specialists share one pre-load).
 */

import { getStateStore, isStateEnabled } from './fileStateStore.js';

const DEFAULT_CACHE_MS = 2_000;

interface CacheEntry {
  text: string;
  at: number;
  projectRoot: string;
}

let cache: CacheEntry | null = null;

/** Drop the process cache (tests / after commit). */
export function clearDurableContextCache(): void {
  cache = null;
}

/**
 * Load materializeContext(HEAD) for a project. Empty string when disabled,
 * missing HEAD, or I/O failure (fail-open).
 */
export async function loadDurableContext(
  projectRoot: string,
  opts?: { maxChars?: number; cacheMs?: number; env?: NodeJS.ProcessEnv },
): Promise<string> {
  const env = opts?.env ?? process.env;
  if (!isStateEnabled(env)) return '';

  const cacheMs = opts?.cacheMs ?? DEFAULT_CACHE_MS;
  const now = Date.now();
  if (
    cache &&
    cache.projectRoot === projectRoot &&
    now - cache.at < cacheMs
  ) {
    return cache.text;
  }

  try {
    const store = await getStateStore(projectRoot, env);
    const text = await store.materializeContext(undefined, opts?.maxChars);
    cache = { text: text || '', at: now, projectRoot };
    return cache.text;
  } catch {
    return '';
  }
}
