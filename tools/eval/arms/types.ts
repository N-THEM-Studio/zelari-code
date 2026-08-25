/**
 * tools/eval/arms/types.ts — PHASE 6 A/B experiment contracts (upgrade doc
 * §79–§86). EvalCase × EvalArm matrix with reproducible manifests.
 *
 * JSON + zod, zero new runtime deps. An arm is an ENV DIFF over the runner's
 * base environment (§82–§83): value '' REMOVES the key, so an arm can clear
 * inherited routing (e.g. ZELARI_KRAKEN_EXPLORE_MODEL='').
 */

import { z } from 'zod';

/** One eval task with a deterministic fixture workspace (§81). */
export const EvalCaseSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  /** Directory the CLI runs in (fixture workspace). */
  cwdFixture: z.string().min(1),
  expected: z
    .object({
      /** Files that must exist after the run. */
      files: z.array(z.string().min(1)).optional(),
      /** Deterministic command run in the fixture AFTER the agent. */
      command: z
        .object({
          cmd: z.string().min(1),
          expectExit: z.number().int().min(0).default(0),
        })
        .optional(),
    })
    .optional(),
  timeoutMs: z.number().int().positive().optional(),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

/** One experimental arm = env diff (+ optional metadata, §82). */
export const EvalArmSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'arm id must be kebab-case'),
  env: z.record(z.string(), z.string()),
  /** Metadata only — providers/models are selected via env diff. */
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});
export type EvalArm = z.infer<typeof EvalArmSchema>;

/** Metrics extracted from one run's NDJSON output (§84). */
export interface ArmRunMetrics {
  passed: boolean;
  /** Wall time from first to last event ts. */
  durationMs: number;
  modelCalls: number;
  toolCalls: number;
  toolFailures: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** agent_start events carrying a parentAgentId (0 if the field is absent). */
  tentacles: number;
  retries: number;
  /** Populated only when `verification_failed` events exist on the stream. */
  verificationFailures: number;
  /** `runtime_warning` events (§90) — 0 until the CLI emits them. */
  guardWarnings: number;
  compactions: number;
  /** `tool_result_spilled` events (§93) — 0 until the CLI emits them. */
  spillCount: number;
  /** read_file tool calls whose target is a run spill file (heuristic). */
  recoveryReads: number;
}

/** One case × arm execution result. */
export interface ArmRunRecord {
  armId: string;
  caseId: string;
  metrics: ArmRunMetrics;
  ndjsonLines: number;
  /** Non-fatal capture failure (spawn error, timeout) → passed=false. */
  error?: string;
}

/** Reproducibility manifest (§86): enough context to re-run the experiment. */
export interface ExperimentManifest {
  version: 1;
  experimentId: string;
  createdAt: string;
  gitCommit: string;
  cliVersion: string;
  provider?: string;
  model?: string;
  arms: Array<{ id: string; envDiff: Record<string, string> }>;
  cases: Array<{ id: string; fixtureHash: string }>;
  runs: ArmRunRecord[];
}
