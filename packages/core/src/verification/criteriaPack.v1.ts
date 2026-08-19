/**
 * verification/criteriaPack.v1.ts — Zelari Coding Criteria Pack v1.
 *
 * Category ids follow the plan §3A.4 taxonomy:
 *   correctness.{specification, observable-output, error-signals}
 *   quality.{scope-discipline, regression-risk}
 *   evidence.verification-quality
 *
 * Commands are repo-overridable; passing `null` leaves the criterion without
 * a deterministic check → honestly `unknown` (advisory), never `pass`.
 */

import type { Criterion } from './types.js';

export const ZELARI_CODING_PACK_ID = 'zelari-coding/v1';

export interface CodingPackOptions {
  typecheckCommand?: string | null;
  testCommand?: string | null;
  buildCommand?: string | null;
  /** e.g. `git diff --name-only <base>` compared against a scope allowlist. */
  scopeCommand?: string | null;
  commandTimeoutMs?: number;
}

export interface CriteriaPack {
  id: string;
  criteria: Criterion[];
}

export function codingCriteriaPack(options: CodingPackOptions = {}): CriteriaPack {
  const timeoutMs = options.commandTimeoutMs ?? 600_000;
  /** undefined = use default; null = explicitly unbound (no deterministic check). */
  const withDefault = (o: string | null | undefined, d: string): string | null => (o === undefined ? d : o);
  const command = (command: string | null | undefined): Criterion['check'] =>
    command ? { kind: 'command', command, timeoutMs } : undefined;

  const criteria: Criterion[] = [
    {
      id: 'correctness.error-signals',
      text: 'Static checks (typecheck) pass with no new errors.',
      source: 'criteria-pack',
      required: true,
      check: command(withDefault(options.typecheckCommand, 'npm run typecheck')),
    },
    {
      id: 'correctness.specification',
      text: 'The test suite passes — behavior matches the specification.',
      source: 'criteria-pack',
      required: true,
      check: command(withDefault(options.testCommand, 'npm run test')),
    },
    {
      id: 'correctness.observable-output',
      text: 'The project builds successfully (observable output artifact).',
      source: 'criteria-pack',
      required: true,
      check: command(withDefault(options.buildCommand, 'npm run build')),
    },
    {
      id: 'quality.scope-discipline',
      text: 'No unrelated files changed (minimal diff discipline).',
      source: 'criteria-pack',
      required: false,
      check: command(options.scopeCommand),
    },
    {
      id: 'evidence.verification-quality',
      text: 'Verification evidence is traceable to the original tool output.',
      source: 'criteria-pack',
      required: false,
      check: {
        kind: 'none',
        reason: 'advisory: audited via EvidenceRef digests on the session spine',
      },
    },
  ];

  return { id: ZELARI_CODING_PACK_ID, criteria };
}
