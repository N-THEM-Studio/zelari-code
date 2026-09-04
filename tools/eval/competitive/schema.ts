/**
 * tools/eval/competitive/schema.ts — zod schemas for the competitive bench
 * (t35+t36, closes t31): the same pinned anchors run against zelari AND the
 * competitor CLIs (codex / claude / opencode). Advisory-only output — never
 * a CI gate. Zero deps beyond zod (already a repo dep).
 */

import { z } from 'zod';

export const AGENT_IDS = ['zelari', 'codex', 'claude', 'opencode'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const RunStatusSchema = z.enum(['pass', 'fail', 'error', 'skip']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * Token usage when an agent reports it. Today only zelari's NDJSON stream can
 * carry a usage event; competitors have no stable machine-readable format, so
 * their records stay honest `null` (report renders "n/a", never a guess).
 */
export const TokenUsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheHit: z.number().int().nonnegative().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/** One agent execution on one anchor (one line of runs.jsonl). */
export const CompetitiveRunRecordSchema = z.object({
  agent: z.enum(AGENT_IDS),
  agentLabel: z.string().min(1),
  /** Probed `--version` at run time; null when the agent does not report one. */
  agentVersion: z.string().nullable(),
  model: z.string().nullable(),
  anchorId: z.string().min(1),
  anchorVersion: z.number().int().positive(),
  /** 0-based repetition of the same (agent, anchor) pair — report takes medians. */
  runIndex: z.number().int().nonnegative(),
  /** Golden signal = deterministic success checks (doc §7.7), not agent exit code. */
  status: RunStatusSchema,
  exitCode: z.number().int().nullable(),
  wallMs: z.number().nonnegative(),
  /** First failing success check (`cmd → exit N (expected M)`), null on pass. */
  checksFailed: z.string().nullable(),
  tokens: TokenUsageSchema.nullable(),
  /** USD when derivable; no agent publishes stable pricing here → usually null. */
  costUsd: z.number().nullable(),
  detail: z.string().default(''),
  recordedAt: z.string().min(1),
});
export type CompetitiveRunRecord = z.infer<typeof CompetitiveRunRecordSchema>;

/** Per-agent resolution entry in the run manifest (found? version? note?). */
export const AgentResolutionSchema = z.object({
  agent: z.enum(AGENT_IDS),
  available: z.boolean(),
  version: z.string().nullable(),
  note: z.string().default(''),
});
export type AgentResolution = z.infer<typeof AgentResolutionSchema>;

/** Run manifest (manifest.json): what was planned, pinned, and with which flags. */
export const BenchManifestSchema = z.object({
  kind: z.literal('competitive-bench'),
  recordedAt: z.string().min(1),
  dryRun: z.boolean(),
  flags: z.object({
    anchors: z.array(z.string().min(1)),
    agents: z.array(z.enum(AGENT_IDS)),
    runs: z.number().int().positive(),
  }),
  /** Pinned anchor identities at run time (id + version actually executed). */
  anchors: z.array(
    z.object({
      id: z.string().min(1),
      version: z.number().int().positive(),
      tier: z.number().int(),
    }),
  ),
  agents: z.array(AgentResolutionSchema),
  versions: z.object({
    /** zelari version, read from package.json (no spawn needed). */
    zelari: z.string().nullable(),
  }),
});
export type BenchManifest = z.infer<typeof BenchManifestSchema>;
