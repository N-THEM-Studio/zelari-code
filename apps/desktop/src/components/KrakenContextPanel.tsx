/**
 * Kraken context panel — the ONE session strip in the chat activity stack.
 *
 * Everything live/session-scoped lives here and nowhere else:
 *  - phase / mode / tentacle counters (CLI `kraken_progress` events,
 *    parsed by the KrakenProgressCard readers)
 *  - the context/compaction meter — the only one in the chat; the
 *    end-of-turn footer (TurnStatsCard) owns the per-turn record instead
 *  - budget occupancy + policy, session turns, last verdict, compactions,
 *    memory events, context projections (final `harness_state` event)
 *
 * De-noising rules (one signal, one home): the token/tool/elapsed trio
 * renders only while streaming — at rest the per-message footer owns it;
 * phase counters render only when > 0; the mode chip only for `plan`
 * (build is the default, not information).
 *
 * Advisory by contract: renders NOTHING until there is at least one live
 * signal or a kraken phase; a missing/malformed harness event never
 * surfaces as an error.
 */
import { useHarnessState } from "../harnessState";
import type { HarnessVerdict } from "../harnessState";
import {
  KRAKEN_TERMINAL_PHASE,
  krakenPhaseLabel,
  type KrakenProgressView,
} from "./KrakenProgressCard";
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

export function KrakenContextPanel({
  live,
  progress,
}: {
  live: LiveCtxStats;
  progress: KrakenProgressView | null;
}) {
  const state = useHarnessState();
  const hasLive =
    live.ctxTokens > 0 || live.turnTokens > 0 || live.toolCount > 0;
  if (!hasLive && !progress) return null;

  const limit = DEFAULT_CONTEXT_LIMIT;
  const ratio = limit > 0 ? live.ctxTokens / limit : 0;
  const level = contextLevel(ratio);
  const pct = Math.min(100, ratio * 100);

  const phaseLabel = progress ? krakenPhaseLabel(progress.phase) : null;
  const phaseLive = !!progress && progress.phase !== KRAKEN_TERMINAL_PHASE;
  const counts: { label: string; value: string; tone?: "ok" | "warn" }[] = [];
  if (progress) {
    if (progress.exploreTentacles > 0)
      counts.push({
        label: "explore",
        value: String(progress.exploreTentacles),
      });
    if (progress.verifyTentacles > 0)
      counts.push({ label: "verify", value: String(progress.verifyTentacles) });
    if (progress.writes > 0)
      counts.push({ label: "writes", value: String(progress.writes) });
    if (typeof progress.checkTotal === "number" && progress.checkTotal > 0) {
      const passed = progress.checksPassed ?? 0;
      counts.push({
        label: "checks",
        value: `${passed}/${progress.checkTotal}`,
        tone: passed >= progress.checkTotal ? "ok" : "warn",
      });
    }
  }

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
        {live.streaming ? (
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
        ) : null}
      </div>

      {phaseLabel ? (
        <div className="kraken-ctx-phase">
          <span
            className={`kraken-ctx-phase-label${phaseLive ? " is-live" : " is-done"}`}
          >
            {phaseLive ? <span className="kraken-ctx-dot" aria-hidden /> : null}
            {phaseLabel}
          </span>
          {progress?.mode === "plan" ? (
            <span className="kraken-ctx-mode">plan</span>
          ) : null}
          {counts.length > 0 ? (
            <span className="kraken-ctx-counts">
              {counts.map((c) => (
                <span key={c.label} className={c.tone ? `is-${c.tone}` : undefined}>
                  {c.label} {c.value}
                </span>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}

      <div
        className={`turn-stats-ctx is-${level}`}
        title={`Context proxy: ${live.ctxTokens.toLocaleString()} / ${limit.toLocaleString()} tokens (best of chars/4, measured turn tokens, last reported context)`}
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
