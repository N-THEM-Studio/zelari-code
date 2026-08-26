/**
 * tools/eval/retentionPolicy.ts — retention budgets for harness promotion
 * (2.6 Track A, doc §8.3-8.4). Presets: stable (0 regressions),
 * experimental (1), research (2) — validity ALWAYS required.
 */

import { z } from 'zod';

export const HarnessRetentionPolicySchema = z.object({
  maxRegressedAnchors: z.number().int().min(0),
  /** Minimum NEW-suite improvement (passed delta) required, if configured. */
  minCurrentImprovement: z.number().int().optional(),
  /** Max allowed % increase in cost per verified solve, if configured. */
  maxCostPerSolveIncreasePct: z.number().min(0).optional(),
  /** Max allowed % increase in wall time per verified solve, if configured. */
  maxWallTimeIncreasePct: z.number().min(0).optional(),
  /**
   * Minimum share of candidate anchor runs that must end VERIFIED
   * (t13, plan §P1.2). Fail-closed: an empty candidate set measures
   * nothing and rejects. Opt-in — presets stay unset.
   */
  minVerificationGatePassRate: z.number().min(0).max(1).optional(),
  requireValidityPass: z.literal(true),
});
export type HarnessRetentionPolicy = z.infer<typeof HarnessRetentionPolicySchema>;

export const RETENTION_PRESETS: Readonly<Record<'stable' | 'experimental' | 'research', HarnessRetentionPolicy>> =
  Object.freeze({
    stable: { maxRegressedAnchors: 0, requireValidityPass: true },
    experimental: { maxRegressedAnchors: 1, requireValidityPass: true },
    research: { maxRegressedAnchors: 2, requireValidityPass: true },
  });
