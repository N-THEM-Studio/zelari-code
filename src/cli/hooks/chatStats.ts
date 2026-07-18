import { calculateCost } from '../modelPricing.js';

/**
 * Compute the next session-stats snapshot after a chat turn (Task G.4.5).
 * Pure helper extracted from app.tsx so the "real usage vs ~4-char fallback"
 * branch is testable without React/Ink.
 *
 * Behavior:
 *  - When `realUsage` is present (provider honored `stream_options.include_usage`),
 *    use those numbers exactly.
 *  - When `realUsage` is null, fall back to the v3-B approximation:
 *    `Math.ceil(text.length / 4)` for both prompt and completion tokens.
 *
 * Cost is computed via `calculateCost(model, prompt, completion)` from
 * `modelPricing.ts`. The result is the new stats object; the caller is
 * responsible for merging it into state via `setSessionStats(prev => ...)`.
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
  const nextCached = (prev.cachedTokens ?? 0) + cachedPromptTokens;
  const nextPrompt = (prev.promptTokens ?? 0) + promptTokens;
  const premiumDelta = Math.max(0, promptTokens - cachedPromptTokens);
  const nextPremium = (prev.premiumTokens ?? 0) + premiumDelta;
  const cacheHitRate = nextPrompt > 0 ? nextCached / nextPrompt : 0;

  let stableBustCount = prev.stableBustCount ?? 0;
  let lastStableHash = prev.lastStableHash;
  if (opts?.stableHash) {
    if (lastStableHash && lastStableHash !== opts.stableHash) {
      stableBustCount += 1;
    }
    lastStableHash = opts.stableHash;
  }

  return {
    totalTokens: prev.totalTokens + promptTokens + completionTokens,
    totalCostUsd: prev.totalCostUsd + turnCost,
    cachedTokens: nextCached,
    contextTokens,
    premiumTokens: nextPremium,
    cacheHitRate,
    promptTokens: nextPrompt,
    lastStableHash,
    stableBustCount,
  };
}