/**
 * tools/eval/types.ts — historical anchor format + run records (2.6 Track A,
 * doc §7). JSON + zod (NOT YAML — zero runtime deps per AGENTS.MD).
 *
 * An anchor is a small, stable, mechanically verifiable capability the
 * harness must not forget. Golden record = verified outcome + cost metrics,
 * never LLM narrative output (doc §7.7).
 */

import { z } from 'zod';

/** Tier 0 = PR smoke · Tier 1 = merge/release gate · Tier 2 = nightly/RC. */
export const ANCHOR_TIERS = [0, 1, 2] as const;
export type AnchorTier = (typeof ANCHOR_TIERS)[number];

export const AnchorSuccessCheckSchema = z.object({
  /** Deterministic shell command run in the anchor workspace AFTER the agent. */
  command: z.string().min(1),
  /** Expected exit code (default 0). */
  expectExit: z.number().int().min(0).optional(),
  /** Human note for the report. */
  note: z.string().min(1).optional(),
});
export type AnchorSuccessCheck = z.infer<typeof AnchorSuccessCheckSchema>;

/** Deterministic workspace setup: inline files (preferred) + optional commands. */
export const AnchorFixtureSchema = z.object({
  files: z
    .array(
      z.object({
        /** Workspace-relative POSIX path ('/' separators). */
        path: z.string().min(1),
        content: z.string(),
      }),
    )
    .default([]),
  /** Optional post-file shell commands (deterministic, no network). */
  commands: z.array(z.string().min(1)).default([]),
});
export type AnchorFixture = z.infer<typeof AnchorFixtureSchema>;

export const AnchorBudgetSchema = z.object({
  maxToolCalls: z.number().int().positive(),
  verificationReserve: z.number().int().min(0).optional(),
  maxTokens: z.number().int().positive().optional(),
  maxWallMs: z.number().int().positive().optional(),
});
export type AnchorBudget = z.infer<typeof AnchorBudgetSchema>;

export const AnchorManifestSchema = z.object({
  /** kebab-case, stable across versions. */
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'anchor id must be kebab-case'),
  /** Anchor task version — bump when task/fixture/success changes. */
  version: z.number().int().positive(),
  tier: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  /** Profile id the anchor must run under (ADR-0022). */
  profile: z.string().regex(/^[a-z0-9-]+\/v\d+$/),
  phase: z.enum(['plan', 'build']),
  /** The task prompt given to the agent. */
  task: z.string().min(1),
  fixture: AnchorFixtureSchema.default({ files: [], commands: [] }),
  success: z.array(AnchorSuccessCheckSchema).min(1),
  budget: AnchorBudgetSchema,
  /** Manifest-diff targeting hints (F10) + report grouping. */
  tags: z.array(z.string().min(1)).default([]),
});
export type AnchorManifest = z.infer<typeof AnchorManifestSchema>;

export type AnchorVerifiedResult = 'pass' | 'fail' | 'blocked';

/** One anchor execution under a specific harness (doc §7.7 baseline record). */
export interface AnchorRunRecord {
  runId: string;
  anchorId: string;
  anchorVersion: number;
  harnessManifestHash: string;
  resourcePolicyHash: string;
  result: AnchorVerifiedResult;
  /** Deterministic success (all checks exit as expected) within budget. */
  verified: boolean;
  cost: import('./cost.js').RunCost;
  exitCode: number;
  /** Machine-readable failure classification. */
  reason?: 'budget-exceeded-tool-calls' | 'budget-exceeded-wall' | 'budget-exceeded-tokens' | 'agent-error' | 'checks-failed' | 'setup-failed';
  detail?: string;
  recordedAt: string;
}

/** Golden baseline: the outcome a candidate is compared against (doc §7.7). */
export interface AnchorBaseline {
  anchorId: string;
  harnessManifestHash: string;
  result: AnchorVerifiedResult;
  verified: boolean;
  cost: import('./cost.js').RunCost;
  recordedAt: string;
}
