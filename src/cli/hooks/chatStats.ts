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
  prev: { totalTokens: number; totalCostUsd: number; cachedTokens?: number },
): { totalTokens: number; totalCostUsd: number; cachedTokens: number } {
  const promptTokens = realUsage ? realUsage.promptTokens : Math.ceil(userText.length / 4);
  const completionTokens = realUsage
    ? realUsage.completionTokens
    : Math.ceil(assistantContent.length / 4);
  // Cached prompt tokens are only known from real provider usage; the
  // char/4 fallback can't distinguish them, so assume 0 there.
  const cachedPromptTokens = realUsage?.cachedPromptTokens ?? 0;
  const turnCost = calculateCost(model, promptTokens, completionTokens, cachedPromptTokens);
  return {
    totalTokens: prev.totalTokens + promptTokens + completionTokens,
    totalCostUsd: prev.totalCostUsd + turnCost,
    cachedTokens: (prev.cachedTokens ?? 0) + cachedPromptTokens,
  };
}