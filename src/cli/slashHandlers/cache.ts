/**
 * Slash handlers for prompt-cache stats (/cache stats).
 */
import { appendSystem } from '../hooks/messageHelpers.js';
import type { ChatMessage } from '../components/ChatStream.js';
import { formatCacheStatsLine, type PromptCacheSessionStats } from '../state/promptCacheStats.js';

export interface CacheSlashContext {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  /** Live session stats from the TUI (optional). */
  sessionStats?: {
    totalCostUsd?: number;
    cachedTokens?: number;
    premiumTokens?: number;
    cacheHitRate?: number;
    promptTokens?: number;
    stableBustCount?: number;
    totalTokens?: number;
  };
}

export function handleCacheStats(ctx: CacheSlashContext): void {
  const s = ctx.sessionStats;
  if (!s || !(s.promptTokens || s.cachedTokens || s.totalTokens)) {
    appendSystem(
      ctx.setMessages,
      '[cache] no session usage yet. Complete a model turn to see hit rate.\n' +
        '  Tip: stable prompt (identity+tools) should stay byte-stable; workspace/plan is volatile.\n' +
        '  Env: ZELARI_PROMPT_CACHE_TTL=1h|5m|auto (Anthropic path when available).',
    );
    return;
  }
  const stats: PromptCacheSessionStats = {
    promptTokens: s.promptTokens ?? 0,
    cachedTokens: s.cachedTokens ?? 0,
    premiumTokens: s.premiumTokens ?? Math.max(0, (s.promptTokens ?? 0) - (s.cachedTokens ?? 0)),
    hitRate: s.cacheHitRate ?? 0,
    estimatedCostUsd: s.totalCostUsd ?? 0,
    stableBustCount: s.stableBustCount ?? 0,
    turns: 0,
  };
  const pct = stats.promptTokens > 0 ? Math.round(stats.hitRate * 100) : 0;
  appendSystem(
    ctx.setMessages,
    `[cache] ${formatCacheStatsLine(stats)}\n` +
      `  hit rate: ${pct}%  · cost ~$${stats.estimatedCostUsd.toFixed(4)}\n` +
      `  (OpenAI-compat: automatic prefix cache; keep system stable prefix free of plan/memory churn.)`,
  );
}
