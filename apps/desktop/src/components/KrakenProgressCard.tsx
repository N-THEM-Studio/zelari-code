/**
 * Kraken selection card (ADR-0020 Fasi 2/10 — Desktop consumer).
 *
 * Renders the sparse `kraken_progress` phase projection (live) and the
 * one-per-turn `kraken_metrics` summary (end of turn) that the CLI emits
 * on its NDJSON stream. Unknown event fields are ignored defensively —
 * the card never throws on payload drift (older/newer CLI builds).
 */
import type { CSSProperties } from "react";

export interface KrakenProgressView {
  phase: string;
  mode: "plan" | "build";
  tentacles: number;
  exploreTentacles: number;
  verifyTentacles: number;
  writes: number;
  phaseEnteredAt: number;
  checkTotal?: number;
  checksPassed?: number;
}

export interface KrakenMetricsView {
  selectionUsed: boolean;
  candidateCount: number;
  candidateTokens: number;
  selectionTokens?: number;
  selectionLatencyMs?: number;
  selectionFallback: boolean;
  selectionFallbackReason?: string;
  needsMoreEvidence: boolean;
  verificationPass: number;
  verificationFail: number;
  verificationUnknown: number;
  repairTriggered: boolean;
  repairSucceeded: boolean;
}

const PHASE_LABELS: Record<string, string> = {
  understanding: "Understanding the request",
  exploring: "Exploring the codebase",
  planning: "Drafting the plan",
  implementing: "Implementing",
  selecting: "Selecting the best path",
  verifying: "Verifying changes",
  repairing: "Repair pass",
  completed: "Turn complete",
};

const TERMINAL_PHASE = "completed";

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function optNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** Defensive read of a `kraken_progress` payload; null when unusable. */
export function readKrakenProgress(ev: unknown): KrakenProgressView | null {
  const p = (ev as { progress?: unknown } | null)?.progress;
  if (!p || typeof p !== "object") return null;
  const r = p as Record<string, unknown>;
  const phase = str(r.phase);
  if (!phase) return null;
  return {
    phase,
    mode: r.mode === "plan" ? "plan" : "build",
    tentacles: num(r.tentacles),
    exploreTentacles: num(r.exploreTentacles),
    verifyTentacles: num(r.verifyTentacles),
    writes: num(r.writes),
    phaseEnteredAt: num(r.phaseEnteredAt),
    checkTotal: optNum(r.checkTotal),
    checksPassed: optNum(r.checksPassed),
  };
}

/** Defensive read of a `kraken_metrics` payload; null when unusable. */
export function readKrakenMetrics(ev: unknown): KrakenMetricsView | null {
  const m = (ev as { metrics?: unknown } | null)?.metrics;
  if (!m || typeof m !== "object") return null;
  const r = m as Record<string, unknown>;
  return {
    selectionUsed: r.selectionUsed === true,
    candidateCount: num(r.candidateCount),
    candidateTokens: num(r.candidateTokens),
    selectionTokens: optNum(r.selectionTokens),
    selectionLatencyMs: optNum(r.selectionLatencyMs),
    selectionFallback: r.selectionFallback === true,
    selectionFallbackReason: str(r.selectionFallbackReason),
    needsMoreEvidence: r.needsMoreEvidence === true,
    verificationPass: num(r.verificationPass),
    verificationFail: num(r.verificationFail),
    verificationUnknown: num(r.verificationUnknown),
    repairTriggered: r.repairTriggered === true,
    repairSucceeded: r.repairSucceeded === true,
  };
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

interface ChipProps {
  label: string;
  value: string;
  tone?: "default" | "ok" | "warn";
}

function Chip({ label, value, tone = "default" }: ChipProps) {
  const style: CSSProperties | undefined =
    tone === "ok"
      ? { color: "var(--ok, #34c77b)" }
      : tone === "warn"
        ? { color: "var(--warn, #e0a83c)" }
        : undefined;
  return (
    <span className="kraken-chip">
      {label} <strong style={style}>{value}</strong>
    </span>
  );
}

interface Props {
  progress: KrakenProgressView | null;
  metrics: KrakenMetricsView | null;
}

export function KrakenProgressCard({ progress, metrics }: Props) {
  if (!progress && !metrics) return null;
  const phaseLabel = progress
    ? (PHASE_LABELS[progress.phase] ?? progress.phase)
    : null;
  const live = !!progress && progress.phase !== TERMINAL_PHASE;
  const showMetrics = !!metrics && metrics.selectionUsed;

  return (
    <div
      className="kraken-card"
      aria-live="polite"
      data-live={live ? "true" : "false"}
    >
      <div className="kraken-card-head">
        <span className="kraken-card-kicker">
          Kraken{metrics?.selectionUsed ? " · selection" : ""}
        </span>
        {phaseLabel ? (
          <span
            className={`kraken-card-phase${live ? " is-live" : " is-done"}`}
          >
            {live ? <span className="kraken-card-dot" aria-hidden /> : null}
            {phaseLabel}
          </span>
        ) : null}
        {progress?.mode ? (
          <span className="kraken-card-mode">{progress.mode}</span>
        ) : null}
      </div>

      {progress ? (
        <div className="kraken-card-chips">
          <Chip label="explore" value={String(progress.exploreTentacles)} />
          <Chip label="verify" value={String(progress.verifyTentacles)} />
          <Chip label="writes" value={String(progress.writes)} />
          {typeof progress.checkTotal === "number" &&
          progress.checkTotal > 0 ? (
            <Chip
              label="checks"
              value={`${progress.checksPassed ?? 0}/${progress.checkTotal}`}
              tone={
                (progress.checksPassed ?? 0) >= progress.checkTotal
                  ? "ok"
                  : "warn"
              }
            />
          ) : null}
        </div>
      ) : null}

      {showMetrics && metrics ? (
        <div className="kraken-card-metrics">
          <div className="kraken-metric-row">
            <Chip label="candidates" value={String(metrics.candidateCount)} />
            <Chip
              label="candidate tokens"
              value={formatTokens(metrics.candidateTokens)}
            />
            {typeof metrics.selectionTokens === "number" ? (
              <Chip
                label="selection"
                value={`${formatTokens(metrics.selectionTokens)} tok${
                  typeof metrics.selectionLatencyMs === "number"
                    ? ` · ${(metrics.selectionLatencyMs / 1000).toFixed(1)}s`
                    : ""
                }`}
              />
            ) : null}
          </div>
          <div className="kraken-metric-row">
            <Chip label="verified" value={`✓${metrics.verificationPass}`} tone="ok" />
            <Chip label="failed" value={`✗${metrics.verificationFail}`} tone="warn" />
            <Chip label="unknown" value={`?${metrics.verificationUnknown}`} />
            {metrics.repairTriggered ? (
              <Chip
                label="repair"
                value={metrics.repairSucceeded ? "recovered" : "attempted"}
                tone={metrics.repairSucceeded ? "ok" : "warn"}
              />
            ) : null}
            {metrics.needsMoreEvidence ? (
              <Chip label="verdict" value="needs more evidence" tone="warn" />
            ) : null}
            {metrics.selectionFallback ? (
              <Chip label="selection" value="fallback" tone="warn" />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
