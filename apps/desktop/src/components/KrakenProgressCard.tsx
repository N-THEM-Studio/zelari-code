/**
 * Kraken progress/metrics parsers (ADR-0020 Fasi 2/10 — Desktop consumer).
 *
 * Parser-only module: defensively projects the sparse `kraken_progress`
 * phase events (live) and the one-per-turn `kraken_metrics` summary (end
 * of turn) that the CLI emits on its NDJSON stream. The card UI that used
 * to live here was folded into the unified session strip
 * (KrakenContextPanel) — one place for phase, mode, counters and context.
 *
 * Unknown event fields are ignored; these readers never throw on payload
 * drift (older/newer CLI builds).
 */

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

/** Phase id that marks a finished turn (label: "Turn complete"). */
export const KRAKEN_TERMINAL_PHASE = "completed";

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

/** Human label for a kraken phase id (falls back to the raw id). */
export function krakenPhaseLabel(phase: string): string {
  return PHASE_LABELS[phase] ?? phase;
}

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
