/**
 * Live Gauntlet host-loop card (gauntlet_progress NDJSON).
 */
import type { CSSProperties } from "react";

export type GauntletPhase =
  | "decomposing"
  | "building"
  | "critiquing"
  | "repairing"
  | "settled"
  | "blocked";

export interface GauntletProgressView {
  phase: GauntletPhase;
  pieceId: string;
  pieceLabel: string;
  pieceIndex: number;
  pieceCount: number;
  round: number;
  maxRounds: number;
  verdict?: "PASS" | "GAP" | "BLOCKED";
  gap?: string;
  winner?: "A" | "B" | "TIE";
  elapsedMs: number;
}

const PHASE_LABELS: Record<GauntletPhase, string> = {
  decomposing: "Decomposing",
  building: "Builder",
  critiquing: "Critic",
  repairing: "Repair",
  settled: "Settled",
  blocked: "Blocked",
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function readGauntletProgress(ev: unknown): GauntletProgressView | null {
  const p = (ev as { progress?: unknown } | null)?.progress;
  if (!p || typeof p !== "object") return null;
  const r = p as Record<string, unknown>;
  const phase = str(r.phase) as GauntletPhase | undefined;
  if (!phase || !(phase in PHASE_LABELS)) return null;
  return {
    phase,
    pieceId: str(r.pieceId) ?? "",
    pieceLabel: str(r.pieceLabel) ?? "Piece",
    pieceIndex: num(r.pieceIndex),
    pieceCount: Math.max(1, num(r.pieceCount) || 1),
    round: num(r.round),
    maxRounds: Math.max(1, num(r.maxRounds) || 1),
    verdict:
      r.verdict === "PASS" || r.verdict === "GAP" || r.verdict === "BLOCKED"
        ? r.verdict
        : undefined,
    gap: str(r.gap),
    winner:
      r.winner === "A" || r.winner === "B" || r.winner === "TIE"
        ? r.winner
        : undefined,
    elapsedMs: num(r.elapsedMs),
  };
}

export function formatGauntletElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

interface Props {
  progress: GauntletProgressView | null;
}

export function GauntletProgressCard({ progress }: Props) {
  if (!progress) return null;
  const live =
    progress.phase !== "settled" && progress.phase !== "blocked";
  const phaseLabel = PHASE_LABELS[progress.phase];
  return (
    <div
      className="kraken-card gauntlet-card"
      aria-live="polite"
      data-live={live ? "true" : "false"}
    >
      <div className="kraken-card-head">
        <span className="kraken-card-kicker">Gauntlet</span>
        <span className={`kraken-card-phase${live ? " is-live" : " is-done"}`}>
          {live ? <span className="kraken-card-dot" aria-hidden /> : null}
          {phaseLabel}
        </span>
        <span className="kraken-card-mode">
          {progress.round <= 0
            ? "decompose"
            : `${progress.pieceIndex + 1}/${progress.pieceCount} · r${progress.round}/${progress.maxRounds}`}
        </span>
      </div>
      <div className="kraken-card-chips">
        <span className="kraken-chip">
          <strong>{progress.pieceLabel}</strong>
        </span>
        {progress.verdict ? (
          <span className="kraken-chip">
            verdict <strong>{progress.verdict}</strong>
          </span>
        ) : null}
        {progress.winner ? (
          <span className="kraken-chip">
            A/B <strong>{progress.winner}</strong>
          </span>
        ) : null}
        <span className="kraken-chip" style={elapsedStyle}>
          {formatGauntletElapsed(progress.elapsedMs)}
        </span>
      </div>
      {progress.gap ? (
        <div className="gauntlet-card-gap">{progress.gap}</div>
      ) : null}
    </div>
  );
}

const elapsedStyle: CSSProperties = { opacity: 0.7 };
