/**
 * Session-level prompt-cache instrumentation (Cache Wars-style metrics).
 *
 * Tracks hit rate, premium vs cached tokens, and how often the *stable*
 * prompt prefix hash changes (stable busts invalidate provider prefix cache).
 */

export interface PromptCacheSessionStats {
  promptTokens: number;
  cachedTokens: number;
  premiumTokens: number;
  hitRate: number;
  estimatedCostUsd: number;
  lastStableHash?: string;
  stableBustCount: number;
  turns: number;
}

export function emptyPromptCacheStats(): PromptCacheSessionStats {
  return {
    promptTokens: 0,
    cachedTokens: 0,
    premiumTokens: 0,
    hitRate: 0,
    estimatedCostUsd: 0,
    stableBustCount: 0,
    turns: 0,
  };
}

/**
 * Fold one turn's usage into session cache stats.
 * premium ≈ uncached prompt tokens (prompt - cached), floored at 0.
 */
export function accumulatePromptCacheStats(
  prev: PromptCacheSessionStats,
  turn: {
    promptTokens: number;
    cachedTokens: number;
    costUsd?: number;
    stableHash?: string;
  },
): PromptCacheSessionStats {
  const promptTokens = prev.promptTokens + Math.max(0, turn.promptTokens);
  const cachedTokens = prev.cachedTokens + Math.max(0, turn.cachedTokens);
  const premiumDelta = Math.max(0, turn.promptTokens - turn.cachedTokens);
  const premiumTokens = prev.premiumTokens + premiumDelta;
  const hitRate = promptTokens > 0 ? cachedTokens / promptTokens : 0;
  let stableBustCount = prev.stableBustCount;
  let lastStableHash = prev.lastStableHash;
  if (turn.stableHash) {
    if (lastStableHash && lastStableHash !== turn.stableHash) {
      stableBustCount += 1;
    }
    lastStableHash = turn.stableHash;
  }
  return {
    promptTokens,
    cachedTokens,
    premiumTokens,
    hitRate,
    estimatedCostUsd: prev.estimatedCostUsd + (turn.costUsd ?? 0),
    lastStableHash,
    stableBustCount,
    turns: prev.turns + 1,
  };
}

/** Format a compact one-line summary for StatusBar / slash output. */
export function formatCacheStatsLine(stats: PromptCacheSessionStats): string {
  const pct = stats.promptTokens > 0 ? Math.round(stats.hitRate * 100) : 0;
  return (
    `cache hit ${pct}%` +
    ` · premium ${stats.premiumTokens}` +
    ` · cached ${stats.cachedTokens}` +
    ` · stable busts ${stats.stableBustCount}` +
    ` · turns ${stats.turns}`
  );
}
