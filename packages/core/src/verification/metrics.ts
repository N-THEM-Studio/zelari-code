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
