/**
 * Kraken context strip — the ONE session readout, in the COMPOSER (not the
 * chat flow: it never pushes the conversation up again). One compact line at
 * rest (`ctx 12.3k/128k · 6%` + phase), the full record on click:
 *
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
import { useEffect, useState } from "react";
import { useHarnessState } from "../harnessState";
import type { HarnessVerdict } from "../harnessState";
import {
  KRAKEN_TERMINAL_PHASE,
  krakenPhaseLabel,
  type KrakenProgressView,
} from "./KrakenProgressCard";
import { computeContextMeter } from "../contextMeter";
import {
  CONTEXT_LABEL,
  DEFAULT_CONTEXT_LIMIT,
  formatDuration,
  formatTokens,
} from "./TurnStatsCard";
import "./chatEnhance.css";

export interface LiveCtxStats {
  /**
   * Proxy numerator for the meter's labeled-estimate path: max(chars/4,
   * measured turn tokens, last prompt size). The authoritative numerator
   * is the spine budget event — computeContextMeter owns that choice.
   */
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

/** Denominator in the compact readout: "128k" reads better than "128.0k". */
function compactWindow(n: number): string {
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}

export function KrakenContextPanel({
  live,
  progress,
  sessionId,
}: {
  live: LiveCtxStats;
  progress: KrakenProgressView | null;
  /** Spine session id of the chat on screen — selects that chat's meter
   *  (Fix E, t62: state is per-conversation, never the last event globally). */
  sessionId?: string | null;
}) {
  const { view: state, receivedAt } = useHarnessState(sessionId);
  // Slow clock tick so a stale budget event flips the meter to its labeled
  // "est." estimate even when no message delta re-renders the strip.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  // Details on demand: the strip keeps ONE line at rest and expands to the
  // full session record only on click (it lives in the composer, not in the
  // chat — it must never push the conversation up again).
  const [open, setOpen] = useState(false);

  const hasLive =
    live.ctxTokens > 0 || live.turnTokens > 0 || live.toolCount > 0;
  if (!hasLive && !progress) return null;

  const support = state?.support;
  // Honest meter (contextMeter.ts): the spine budget event — occupancy +
  // real window, same source as the "budget N%" line below — wins while
  // fresh; anything else renders as the labeled proxy estimate (est.).
  const meter = computeContextMeter({
    spine:
      support?.lastOccupancy !== undefined
        ? {
            occupancy: support.lastOccupancy,
            contextLimit: support.contextLimit,
            receivedAt: receivedAt ?? 0,
          }
        : null,
    proxyTokens: live.ctxTokens,
    fallbackLimit: DEFAULT_CONTEXT_LIMIT,
    now,
  });
  /** Occupancy in tokens, derived from the very meter that paints the %. */
  const usedTokens = Math.round((meter.pct / 100) * meter.limit);

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
  const budget =
    support?.lastOccupancy !== undefined
      ? ` · budget ${Math.round(support.lastOccupancy * 100)}%${
          support.lastPolicy ? ` ${support.lastPolicy}` : ""
        }`
      : "";

  return (
    <section
      className={`kraken-ctx-strip is-${meter.level}${open ? " is-open" : ""}`}
      aria-label="Kraken context"
    >
      {/* One line at rest: meter + phase. Everything else is one click away. */}
      <button
        type="button"
        className="kraken-ctx-line"
        aria-expanded={open}
        aria-label={
          open ? "Kraken context details — collapse" : "Kraken context details — expand"
        }
        onClick={() => setOpen((v) => !v)}
      >
        {live.streaming ? <span className="kraken-ctx-dot" aria-hidden /> : null}
        <span
          className={`kraken-ctx-meter is-${meter.level}`}
          title={meter.tooltip}
        >
          ctx {formatTokens(usedTokens)}/{compactWindow(meter.limit)} ·{" "}
          {meter.pct.toFixed(meter.pct < 10 ? 1 : 0)}%
          {meter.estimated ? " est." : ""}
        </span>
        <progress
          className="kraken-ctx-bar"
          value={meter.pct}
          max={100}
          aria-label={`Context ${meter.pct.toFixed(meter.pct < 10 ? 1 : 0)}%`}
        />
        {phaseLabel ? (
          <>
            <span
              className={`kraken-ctx-phase-label${phaseLive ? " is-live" : " is-done"}`}
            >
              {phaseLive ? <span className="kraken-ctx-dot" aria-hidden /> : null}
              {phaseLabel}
            </span>
            {progress?.mode === "plan" ? (
              <span className="kraken-ctx-mode">plan</span>
            ) : null}
          </>
        ) : null}
        <span className={`kraken-ctx-caret${open ? " is-open" : ""}`} aria-hidden>
          ▾
        </span>
      </button>

      {open ? (
        <div className="kraken-ctx-detail">
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

          {counts.length > 0 ? (
            <span className="kraken-ctx-counts">
              {counts.map((c) => (
                <span key={c.label} className={c.tone ? `is-${c.tone}` : undefined}>
                  {c.label} {c.value}
                </span>
              ))}
            </span>
          ) : null}

          {state ? (
            <div className="kraken-ctx-session">
              {support?.lastPolicy ?? CONTEXT_LABEL[meter.level]} · session{" "}
              {state.turnsTotal} turn{state.turnsTotal === 1 ? "" : "s"}
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
        </div>
      ) : null}
    </section>
  );
}
