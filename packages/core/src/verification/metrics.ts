/**
 * verification/metrics.ts — false-done and verification-cost metrics (plan §23).
 *
 * North star: average cost per verified solved task. These helpers feed the
 * harness-delta benchmark reports (minimal vs kraken vs +verification).
 */

export interface TaskOutcomeSample {
  taskId: string;
  /** The agent claimed the task done. */
  claimedDone: boolean;
  /** Deterministic verification verdict (undefined = not verified). */
  verified?: boolean;
}

export interface FalseDoneStats {
  claimed: number;
  falseDone: number;
  /** falseDone / claimed (0 when nothing was claimed). */
  rate: number;
}

/** Share of claimed-done tasks that did NOT survive deterministic verification. */
export function computeFalseDoneRate(samples: readonly TaskOutcomeSample[]): FalseDoneStats {
  const claimed = samples.filter((s) => s.claimedDone);
  const falseDone = claimed.filter((s) => s.verified !== true);
  return {
    claimed: claimed.length,
    falseDone: falseDone.length,
    rate: claimed.length === 0 ? 0 : falseDone.length / claimed.length,
  };
}

/** Verified solve rate over all tasks (verified / total). */
export function verifiedSolveRate(samples: readonly TaskOutcomeSample[]): number {
  if (samples.length === 0) return 0;
  return samples.filter((s) => s.verified === true).length / samples.length;
}

/** Verification cost ratio; null when total time is unknown/zero. */
export function verificationCostRatio(verificationMs: number, totalMs: number): number | null {
  if (totalMs <= 0) return null;
  return verificationMs / totalMs;
}

/**
 * 2.6 Track B (doc section 15): unified cost-per-verified-solve metrics.
 * Core-side aggregation over cost-bearing samples — the full RunCost type
 * lives in tools/eval/cost.ts (eval tooling boundary); here we accept the
 * minimal cost shape so the core stays dependency-free.
 */
export interface CostedTaskSample extends TaskOutcomeSample {
  modelCostUsd: number;
  wallMs: number;
  toolCalls: number;
}

export interface CostPerVerifiedSolveStats {
  verifiedSolves: number;
  totalCostUsd: number;
  costPerVerifiedSolve: number | null;
  wallMsPerVerifiedSolve: number | null;
  toolCallsPerVerifiedSolve: number | null;
}

/** North-star aggregation: quality (verified) over quantity (cost). */
export function costPerVerifiedSolve(samples: readonly CostedTaskSample[]): CostPerVerifiedSolveStats {
  const solved = samples.filter((s) => s.verified === true);
  const totalCostUsd = samples.reduce((sum, s) => sum + s.modelCostUsd, 0);
  const totalWallMs = samples.reduce((sum, s) => sum + s.wallMs, 0);
  const totalToolCalls = samples.reduce((sum, s) => sum + s.toolCalls, 0);
  const n = solved.length;
  return {
    verifiedSolves: n,
    totalCostUsd: round(totalCostUsd),
    costPerVerifiedSolve: n > 0 ? round(totalCostUsd / n) : null,
    wallMsPerVerifiedSolve: n > 0 ? Math.round(totalWallMs / n) : null,
    toolCallsPerVerifiedSolve: n > 0 ? round(totalToolCalls / n) : null,
  };
}

function round(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
