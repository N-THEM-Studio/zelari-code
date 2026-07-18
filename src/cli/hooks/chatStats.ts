import { calculateCost } from '../modelPricing.js';
import {
  accumulatePromptCacheStats,
  emptyPromptCacheStats,
  type PromptCacheSessionStats,
} from '../state/promptCacheStats.js';

/**
 * Compute the next session-stats snapshot after a chat turn (Task G.4.5).
 * Pure helper extracted from app.tsx so the "real usage vs ~4-char fallback"
 * branch is testable without React/Ink.
 *
 * Cache hit/premium/stable-bust math is delegated to `accumulatePromptCacheStats`
 * (single source of truth with `/cache stats`).
 */
export function computeSessionStatsDelta(
  realUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedPromptTokens?: number;
  } | null,
  userText: string,
  assistantContent: string,
  model: string,
  prev: {
    totalTokens: number;
    totalCostUsd: number;
    cachedTokens?: number;
    /** Last-turn context occupancy (for the StatusBar meter, not cumulative). */
    contextTokens?: number;
    /** Cumulative uncached (premium) prompt tokens. */
    premiumTokens?: number;
    /** Session prompt-cache hit rate 0..1 (weighted by tokens). */
    cacheHitRate?: number;
    /** Cumulative prompt tokens (for hit rate). */
    promptTokens?: number;
    lastStableHash?: string;
    stableBustCount?: number;
  },
  opts?: { stableHash?: string },
): {
  totalTokens: number;
  totalCostUsd: number;
  cachedTokens: number;
  contextTokens: number;
  premiumTokens: number;
  cacheHitRate: number;
  promptTokens: number;
  lastStableHash?: string;
  stableBustCount: number;
} {
  const promptTokens = realUsage ? realUsage.promptTokens : Math.ceil(userText.length / 4);
  const completionTokens = realUsage
    ? realUsage.completionTokens
    : Math.ceil(assistantContent.length / 4);
  // Cached prompt tokens are only known from real provider usage; the
  // char/4 fallback can't distinguish them, so assume 0 there.
  const cachedPromptTokens = realUsage?.cachedPromptTokens ?? 0;
  const turnCost = calculateCost(model, promptTokens, completionTokens, cachedPromptTokens);
  // Context meter = this turn's prompt+completion (provider context window
  // occupancy proxy), NOT the session cumulative total (which always grows
  // and produced absurd "474k/200k" displays).
  const contextTokens = realUsage
    ? realUsage.totalTokens || promptTokens + completionTokens
    : promptTokens + completionTokens;

  const prevCache: PromptCacheSessionStats = {
    ...(emptyPromptCacheStats()),
    promptTokens: prev.promptTokens ?? 0,
    cachedTokens: prev.cachedTokens ?? 0,
    premiumTokens: prev.premiumTokens ?? 0,
    hitRate: prev.cacheHitRate ?? 0,
    estimatedCostUsd: prev.totalCostUsd,
    lastStableHash: prev.lastStableHash,
    stableBustCount: prev.stableBustCount ?? 0,
    turns: 0,
  };
  const nextCache = accumulatePromptCacheStats(prevCache, {
    promptTokens,
    cachedTokens: cachedPromptTokens,
    costUsd: turnCost,
    stableHash: opts?.stableHash,
  });

  return {
    totalTokens: prev.totalTokens + promptTokens + completionTokens,
    totalCostUsd: prev.totalCostUsd + turnCost,
    cachedTokens: nextCache.cachedTokens,
    contextTokens,
    premiumTokens: nextCache.premiumTokens,
    cacheHitRate: nextCache.hitRate,
    promptTokens: nextCache.promptTokens,
    lastStableHash: nextCache.lastStableHash,
    stableBustCount: nextCache.stableBustCount,
  };
}

/** Resolve prompt-cache TTL preference (honest: only meaningful on Anthropic path). */
export function resolvePromptCacheTtl(
  env: NodeJS.ProcessEnv = process.env,
): '1h' | '5m' | 'auto' {
  const raw = (env.ZELARI_PROMPT_CACHE_TTL ?? 'auto').toLowerCase().trim();
  if (raw === '1h' || raw === '1hour' || raw === 'long') return '1h';
  if (raw === '5m' || raw === '5min' || raw === 'short') return '5m';
  return 'auto';
}