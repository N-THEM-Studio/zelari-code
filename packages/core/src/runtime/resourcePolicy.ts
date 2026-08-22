/**
 * runtime/resourcePolicy.ts — host-owned resource policy (2.6 Track B, doc §11-12).
 *
 * The policy is BEHAVIOURAL: it shapes how the agent spends its remaining
 * budget, so its hash feeds the harness manifest (§6.6). Enforcement stays
 * host-side; the model only ever sees a projection (doc §9.2).
 *
 * Pressure thresholds are policy-configurable, NOT copied from other
 * domains (§12.3): defaults below are first-guess values to be replaced by
 * Zelari's own benchmark data.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { stableStringify } from '../core/requestSnapshot.js';

export const BudgetPressureSchema = z.enum(['ample', 'normal', 'constrained', 'critical']);
export type BudgetPressure = z.infer<typeof BudgetPressureSchema>;

/** Operational stage of the run — deliberately NOT named `phase` (WorkPhase collision). */
export const ResourceStageSchema = z.enum(['explore', 'implement', 'verify', 'repair']);
export type ResourceStage = z.infer<typeof ResourceStageSchema>;

/** Fractions of (limit - reserve floor) at which pressure bands change. */
export const PressureThresholdsSchema = z.object({
  /** remaining/usable >= ample → ample. */
  ample: z.number().min(0).max(1),
  /** remaining/usable >= constrained → normal; below → constrained. */
  constrained: z.number().min(0).max(1),
  /** remaining/usable < critical → critical. */
  critical: z.number().min(0).max(1),
});
export type PressureThresholds = z.infer<typeof PressureThresholdsSchema>;

export const DEFAULT_PRESSURE_THRESHOLDS: PressureThresholds = Object.freeze({
  ample: 0.5,
  constrained: 0.25,
  critical: 0.1,
});

export const ResourcePolicySchema = z.object({
  maxToolCalls: z.number().int().positive(),
  reserve: z.object({
    /** Protected: tool budget the non-verification loop may not consume (§11.4). */
    verification: z.number().int().min(0),
    /** Advisory-only by default (§11.4). */
    repair: z.number().int().min(0),
  }),
  wallClockMs: z.number().int().positive().optional(),
  /** Soft token ceiling (advisory telemetry, not enforced). */
  softMaxTokens: z.number().int().positive().optional(),
  pressure: PressureThresholdsSchema.default(DEFAULT_PRESSURE_THRESHOLDS),
});
export type ResourcePolicy = z.infer<typeof ResourcePolicySchema>;

/** Default policies per profile (doc §11.2 kraken default 40/6/4/900000). */
export const PROFILE_RESOURCE_POLICIES: Readonly<Record<string, ResourcePolicy>> = Object.freeze({
  'minimal/v1': {
    maxToolCalls: 25,
    reserve: { verification: 4, repair: 3 },
    pressure: DEFAULT_PRESSURE_THRESHOLDS,
  },
  'kraken/v1': {
    maxToolCalls: 40,
    reserve: { verification: 6, repair: 4 },
    wallClockMs: 900_000,
    pressure: DEFAULT_PRESSURE_THRESHOLDS,
  },
  'council/v1': {
    maxToolCalls: 30,
    reserve: { verification: 4, repair: 2 },
    pressure: DEFAULT_PRESSURE_THRESHOLDS,
  },
  'mission/v1': {
    maxToolCalls: 60,
    reserve: { verification: 8, repair: 6 },
    wallClockMs: 1_800_000,
    pressure: DEFAULT_PRESSURE_THRESHOLDS,
  },
});

export function defaultResourcePolicy(profileId: string): ResourcePolicy {
  return PROFILE_RESOURCE_POLICIES[profileId] ?? PROFILE_RESOURCE_POLICIES['kraken/v1']!;
}

/** Canonical behavioural hash — the manifest's `policies.resourcePolicyHash`. */
export function resourcePolicyHash(policy: ResourcePolicy): string {
  return createHash('sha256').update(stableStringify(ResourcePolicySchema.parse(policy))).digest('hex');
}
