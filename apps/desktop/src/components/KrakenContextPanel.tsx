/**
 * Kraken context panel — realtime, permanent context/compaction strip that
 * lives in the chat activity stack (right where HarnessStatePanel used to
 * be, which this component replaces).
 *
 * Two sources, one strip:
 *  - `live` (App-derived): recomputed on every message delta, so the
 *    context meter, token split, tool count and elapsed time update in
 *    REAL TIME while the model streams. Context size is a chars/4 proxy
 *    (marked `~`) crossed with the turn's measured tokens — the Desktop
 *    event stream does not carry usage events yet.
 *  - `useHarnessState()` (CLI final `harness_state` event): session turns,
 *    last verdict (unknown ≠ pass), compactions, memory events, context
 *    projections, and the real budget occupancy/policy when the CLI
 *    reports it.
 *
 * Advisory by contract: renders NOTHING until there is at least one live
 * signal; a missing/malformed harness event never surfaces as an error.
 */
import { useHarnessState } from "../harnessState";
import type { HarnessVerdict } from "../harnessState";
import {
  CONTEXT_LABEL,
  DEFAULT_CONTEXT_LIMIT,
  contextLevel,
  formatDuration,
  formatTokens,
} from "./TurnStatsCard";
import "./chatEnhance.css";

export interface LiveCtxStats {
  /** Context proxy: max(chars/4 over visible messages, measured turn tokens). */
  ctxTokens: number;
  /** Turn-scoped totals (accumulate across members/tentacles). */
  turnTokens: number;
  promptTokens: number;
  completionTokens: number;
  toolCount: number;
  /** ms since the turn started (null before the first run). */
  elapsedMs: number | null;
  /** True while a run is generating — drives the live dot. */
  streaming: boolean;
}

function verdictColor(v: HarnessVerdict): string | undefined {
  if (v === "PASS") return "var(--ok, #34c77b)";
  if (v === "REPAIR_REQUIRED" || v === "BLOCKED")
    return "var(--danger, #e05a5a)";
  return undefined;
}

export function KrakenContextPanel({ live }: { live: LiveCtxStats }) {
  const state = useHarnessState();
  const hasLive =
    live.ctxTokens > 0 || live.turnTokens > 0 || live.toolCount > 0;
  if (!hasLive) return null;

  const limit = DEFAULT_CONTEXT_LIMIT;
  const ratio = limit > 0 ? live.ctxTokens / limit : 0;
  const level = contextLevel(ratio);
  const pct = Math.min(100, ratio * 100);

  const lastTurn =
    state && state.turns.length > 0
      ? state.turns[state.turns.length - 1]
      : undefined;
  const support = state?.support;
  const budget =
    support?.lastOccupancy !== undefined
      ? ` · budget ${Math.round(support.lastOccupancy * 100)}%${
          support.lastPolicy ? ` ${support.lastPolicy}` : ""
        }`
      : "";

  return (
    <section className="kraken-ctx-panel" aria-label="Kraken context">
      <div className="kraken-ctx-head">
        <span className="kraken-ctx-kicker">
          {live.streaming ? (
            <span className="kraken-ctx-dot" aria-hidden />
          ) : null}
          Kraken · context
        </span>
        <span className="kraken-ctx-nums">
          {live.turnTokens > 0 ? (
            <span
              title={`Turn tokens — prompt ▲ ${live.promptTokens.toLocaleString()} · completion ▼ ${live.completionTokens.toLocaleString()}`}
            >
              ▲ {formatTokens(live.promptTokens)} · ▼{" "}
              {formatTokens(live.completionTokens)} · Σ{" "}
              {live.turnTokens.toLocaleString()}
            </span>
          ) : null}
          {live.toolCount > 0 ? (
            <span title="Tool calls this turn">🛠 {live.toolCount}</span>
          ) : null}
          {live.elapsedMs != null ? (
            <span title="Turn elapsed">⏱ {formatDuration(live.elapsedMs)}</span>
          ) : null}
        </span>
      </div>

      <div
        className={`turn-stats-ctx is-${level}`}
        title={`Context proxy: ${live.ctxTokens.toLocaleString()} / ${limit.toLocaleString()} tokens (~chars/4 crossed with measured turn tokens)`}
      >
        <span className="turn-stats-ctx-bar" aria-hidden>
          <span
            className="turn-stats-ctx-fill"
            style={{ width: `${pct.toFixed(1)}%` }}
          />
        </span>
        <span className="turn-stats-ctx-label">
          ctx ~{pct.toFixed(pct < 10 ? 1 : 0)}% ·{" "}
          {support?.lastPolicy ?? CONTEXT_LABEL[level]}
        </span>
      </div>

      {state ? (
        <div className="kraken-ctx-session">
          session {state.turnsTotal} turn{state.turnsTotal === 1 ? "" : "s"}
          {lastTurn ? (
            <span style={{ color: verdictColor(lastTurn.verdict) }}>
              {" "}
              · last {lastTurn.verdict}
            </span>
          ) : null}
          {support ? (
            <>
              {" · compactions "}
              {support.compactions}
              {" · memory "}
              {support.memoryEvents}
              {" · projections "}
              {support.contextProjections}
            </>
          ) : null}
          {budget}
        </div>
      ) : null}
    </section>
  );
}
