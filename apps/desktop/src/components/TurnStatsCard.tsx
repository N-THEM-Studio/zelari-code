/**
 * End-of-turn stats footer for assistant replies — the Desktop twin of the
 * CLI end-of-run status line (the "white prints": tokens, context,
 * compaction, cache).
 *
 * Shows: response time, tool calls, token split (▲ prompt · ▼ completion ·
 * Σ total) and char count — the per-turn RECORD only. The context/
 * compaction meter lives solely in the session strip (KrakenContextPanel):
 * one signal, one home. Cache metrics (⚡ hit rate / cached tokens) render
 * only when the CLI reports them — the Desktop event stream does not
 * carry usage events yet.
 */
import type { MessageStats } from "../types";
import "./chatEnhance.css";

/** Default context window for the meter (matches the CLI budget pipeline). */
export const DEFAULT_CONTEXT_LIMIT = 200_000;

const CTX_GROWING = 0.7;
const CTX_COMPACT = 0.85;
const CTX_HARD = 0.95;

export type ContextLevel = "ok" | "growing" | "compact" | "hard";

export function contextLevel(ratio: number): ContextLevel {
  if (ratio >= CTX_HARD) return "hard";
  if (ratio >= CTX_COMPACT) return "compact";
  if (ratio >= CTX_GROWING) return "growing";
  return "ok";
}

export const CONTEXT_LABEL: Record<ContextLevel, string> = {
  ok: "ok",
  growing: "context growing",
  compact: "compaction soon",
  hard: "compaction imminent",
};

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  return s < 60
    ? `${s.toFixed(1)}s`
    : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function TurnStatsCard({ stats }: { stats: MessageStats }) {
  const hasData =
    stats.durationMs != null ||
    (stats.totalTokens ?? 0) > 0 ||
    (stats.toolCount ?? 0) > 0;
  if (!hasData) return null;

  return (
    <div className="msg-stats reply-stats turn-stats">
      <div className="turn-stats-row">
        {stats.durationMs != null ? (
          <span title="Response time">
            ⏱ {formatDuration(stats.durationMs)}
          </span>
        ) : null}
        {(stats.toolCount ?? 0) > 0 ? (
          <span title="Tool calls this turn">🛠 {stats.toolCount}</span>
        ) : null}
        {(stats.totalTokens ?? 0) > 0 ? (
          <span
            title={`Prompt ▲ ${stats.promptTokens?.toLocaleString() ?? "0"} · Completion ▼ ${stats.completionTokens?.toLocaleString() ?? "0"}`}
          >
            ▲ {formatTokens(stats.promptTokens ?? 0)} · ▼{" "}
            {formatTokens(stats.completionTokens ?? 0)} · Σ{" "}
            {stats.totalTokens?.toLocaleString()} tok
          </span>
        ) : null}
        {(stats.charCount ?? 0) > 0 ? (
          <span title="Characters">
            {stats.charCount?.toLocaleString()} chars
          </span>
        ) : null}
        {stats.cacheHitRate != null ? (
          <span title="Prompt cache hit rate">
            ⚡ {(stats.cacheHitRate * 100).toFixed(0)}% cache
          </span>
        ) : null}
        {stats.cachedTokens != null && stats.cachedTokens > 0 ? (
          <span title="Cached tokens">
            {formatTokens(stats.cachedTokens)} cached
          </span>
        ) : null}
      </div>
    </div>
  );
}
