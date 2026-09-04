/**
 * End-of-turn stats footer for assistant replies — the Desktop twin of the
 * CLI end-of-run status line (the "white prints": tokens, context,
 * compaction, cache).
 *
 * Shows: response time, tool calls, token split (▲ prompt · ▼ completion ·
 * Σ total), char count, and a context/compaction meter using the same
 * thresholds as the CLI budget pipeline (ok < 0.70 ≤ growing < 0.85 ≤
 * compaction soon < 0.95 ≤ compaction imminent). Cache metrics (⚡ hit
 * rate / cached tokens) render only when the CLI reports them — the
 * Desktop event stream does not carry usage events yet.
 *
 * Context size is a proxy (prompt tokens of the last model call), the
 * best signal available without CLI changes; the `~` marks it as such.
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

  const limit = stats.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
  const ctx = stats.contextTokens ?? stats.promptTokens ?? 0;
  const ratio = limit > 0 ? ctx / limit : 0;
  const level = contextLevel(ratio);
  const pct = Math.min(100, ratio * 100);

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
      {ctx > 0 && limit > 0 ? (
        <div
          className={`turn-stats-ctx is-${level}`}
          title={`Context proxy (~prompt tokens): ${ctx.toLocaleString()} / ${limit.toLocaleString()}`}
        >
          <span className="turn-stats-ctx-bar" aria-hidden>
            <span
              className="turn-stats-ctx-fill"
              style={{ width: `${pct.toFixed(1)}%` }}
            />
          </span>
          <span className="turn-stats-ctx-label">
            ctx ~{pct.toFixed(pct < 10 ? 1 : 0)}% · {CONTEXT_LABEL[level]}
          </span>
        </div>
      ) : null}
    </div>
  );
}
