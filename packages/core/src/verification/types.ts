/**
 * verification/types.ts — the evidence contract (ADR-0023).
 *
 * Criterion → VerificationResult → EvidenceRef → session event → original
 * tool output. `unknown ≠ pass` everywhere: a criterion that cannot be
 * evaluated deterministically is `unknown`, never `pass`.
 */

import { z } from 'zod';

export const CriterionSourceSchema = z.enum([
  'task',
  'plan',
  'kraken-selection',
  'mission',
  'criteria-pack',
]);
export type CriterionSource = z.infer<typeof CriterionSourceSchema>;

export const CommandCheckSchema = z.object({
  kind: z.literal('command'),
  command: z.string().min(1),
  /** Expected exit code (default 0). */
  expectExit: z.number().int().optional(),
  /** Required stdout substring. */
  expectStdoutIncludes: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const FileExistsCheckSchema = z.object({
  kind: z.literal('file-exists'),
  path: z.string().min(1),
});

export const FileContainsCheckSchema = z.object({
  kind: z.literal('file-contains'),
  path: z.string().min(1),
  /** Substring or valid regex source. */
  pattern: z.string().min(1),
});

export const FileAbsentCheckSchema = z.object({
  kind: z.literal('file-absent'),
  path: z.string().min(1),
});

export const NoneCheckSchema = z.object({
  kind: z.literal('none'),
  reason: z.string().optional(),
});

export const DeterministicCheckSchema = z.discriminatedUnion('kind', [
  CommandCheckSchema,
  FileExistsCheckSchema,
  FileContainsCheckSchema,
  FileAbsentCheckSchema,
  NoneCheckSchema,
]);
export type DeterministicCheck = z.infer<typeof DeterministicCheckSchema>;

export const CriterionSchema = z.object({
  id: z.string().min(1),
  /** Human-readable statement of what "done" means for this criterion. */
  text: z.string().min(1),
  source: CriterionSourceSchema,
  /** Required criteria gate completion; optional ones are advisory. */
  required: z.boolean(),
  check: DeterministicCheckSchema.optional(),
});
export type Criterion = z.infer<typeof CriterionSchema>;

export const EvidenceTierSchema = z.enum([
  'tool-output',
  'command-output',
  'fs-observation',
  'verifier-llm',
  'human',
]);
export type EvidenceRefTier = z.infer<typeof EvidenceTierSchema>;

export const EvidenceRefSchema = z.object({
  /** Seq of the originating session event, when the evidence is logged. */
  seq: z.number().int().positive().optional(),
  tier: EvidenceTierSchema,
  /** Human-readable pointer: command line, file path, tool call id… */
  ref: z.string().min(1),
  capturedAt: z.number().int().nonnegative(),
  /** sha256 of the captured output (audit chain). */
  digest: z.string().optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const VerificationStatusSchema = z.enum(['pass', 'fail', 'unknown']);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

export const VerificationSourceSchema = z.enum([
  'deterministic-engine',
  'verify-agent',
  'verifier-model',
  'human',
]);
export type VerificationSource = z.infer<typeof VerificationSourceSchema>;

export const VerificationResultSchema = z.object({
  criterionId: z.string().min(1),
  status: VerificationStatusSchema,
  source: VerificationSourceSchema,
  evidence: z.array(EvidenceRefSchema),
  evaluatedAt: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  detail: z.string().optional(),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
