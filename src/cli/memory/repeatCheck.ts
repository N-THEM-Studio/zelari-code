/**
 * Repeat-check proposals (slice A of the "steal Cursor Projects" plan).
 *
 * A fingerprint seen twice produces a `constraint` candidate (slice 3.2,
 * `repeatFailure.ts` + `opsKnowledge.ts`). That candidate is only TEXT: the
 * circle closes when it becomes a *certifiable check* for
 * `.zelari/world/checks.json`.
 *
 * This module owns the pure half of that step: turn a constraint node into a
 * `CheckProposal` a human can inspect, and turn a human confirmation into the
 * `WorldCheck` to append. Nothing here touches disk — generating a proposal is
 * free, applying one is always an explicit, human-typed action.
 *
 * Hard rule: the suggested check is NEVER an automatic re-run of the command
 * that failed. A failing command is the symptom, not the regression test; the
 * template defaults to a placeholder the human must replace, or to the command
 * of a *verified* procedure for the same digest when one exists in memory.
 */
import type { MemoryNode } from '@zelari/core/memory';
import type { WorldCheck } from '../workspace/worldModel.js';
import { failureCommandLabel, guessExitCode } from './repeatFailure.js';

/**
 * Placeholder command. Deliberately not a shell no-op: an unedited template
 * must fail loudly if it ever reaches `checks.json` (which it cannot — see
 * `confirmCheck`), instead of producing a fake green check.
 */
export const PLACEHOLDER_COMMAND = '<confirm-command>';

/** The `constraint` node fields a check proposal is built from. */
export interface ConstraintInput {
  fingerprint: string;
  /** The command that failed (context only — never re-run automatically). */
  command: string;
  digest: string;
  exitCode: number;
  criterionId?: string;
}

export interface CheckProposal {
  /** Failure fingerprint the constraint was keyed by. */
  fp: string;
  /** The failed command, kept for the human's eyes only. */
  command: string;
  /** Exit code observed on the failing run. */
  exit: number;
  /** Output digest of the failing run. */
  digest: string;
  /** Stable id of the check once appended (== the memory node id). */
  checkId: string;
  /** True when `suggestedCheck.command` came from a verified fix procedure. */
  derivedFromProcedure: boolean;
  /** Template for human confirmation — never applied automatically. */
  suggestedCheck: WorldCheck;
}

function metaString(node: MemoryNode, key: string): string | undefined {
  const value = node.metadata?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function metaNumber(node: MemoryNode, key: string): number | undefined {
  const value = node.metadata?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Memory id of the constraint a repeated fingerprint promotes to. */
export function checkIdForFingerprint(fingerprint: string): string {
  return `con-${fingerprint}`;
}

/**
 * Read the check-relevant fields out of a memory node. Returns null when the
 * node is not a repeat-failure constraint (no fingerprint / command / digest):
 * only nodes the slice-3.2 writer produced are proposable.
 */
export function constraintFromNode(node: MemoryNode | null | undefined): ConstraintInput | null {
  if (!node) return null;
  const fingerprint = metaString(node, 'fingerprint');
  const command = metaString(node, 'command');
  const digest = metaString(node, 'digest');
  if (!fingerprint || !command || !digest) return null;
  const criterionId = metaString(node, 'criterionId');
  return {
    fingerprint,
    command,
    digest,
    exitCode: metaNumber(node, 'exitCode') ?? guessExitCode(command),
    ...(criterionId ? { criterionId } : {}),
  };
}

/** Two commands are "the same" when their evidence label is the same. */
function sameCommand(a: string, b: string): boolean {
  return failureCommandLabel(a).toLowerCase() === failureCommandLabel(b).toLowerCase();
}

/**
 * A verified `procedure` for the SAME output digest is the strongest hint we
 * have that a fix exists. A procedure that merely repeats the failed command is
 * not a fix, so it is skipped (never auto-rerun the failing command).
 */
export function pickFixProcedure(
  constraint: ConstraintInput,
  procedures: readonly MemoryNode[] = [],
): MemoryNode | undefined {
  return procedures.find((node) => {
    if (node.kind !== 'procedure' || node.status !== 'active') return false;
    if (node.metadata?.verified !== true) return false;
    const digest = metaString(node, 'digest');
    const command = metaString(node, 'command');
    if (!digest || digest !== constraint.digest || !command) return false;
    return !sameCommand(command, constraint.command);
  });
}

function commandFromProcedure(procedure: MemoryNode): string {
  return metaString(procedure, 'command') ?? PLACEHOLDER_COMMAND;
}

/**
 * Pure: constraint → check template.
 *
 * `expectExit` is always 0: a check asserts "the fix holds". The exit code of
 * the failing run is reported in `exit`, never used as an expectation.
 */
export function proposalFromConstraint(
  constraint: ConstraintInput,
  procedures: readonly MemoryNode[] = [],
): CheckProposal {
  const fix = pickFixProcedure(constraint, procedures);
  const command = fix ? commandFromProcedure(fix) : PLACEHOLDER_COMMAND;
  return {
    fp: constraint.fingerprint,
    command: constraint.command,
    exit: constraint.exitCode,
    digest: constraint.digest,
    checkId: checkIdForFingerprint(constraint.fingerprint),
    derivedFromProcedure: fix !== undefined,
    suggestedCheck: {
      id: checkIdForFingerprint(constraint.fingerprint),
      command,
      expectExit: 0,
    },
  };
}

/**
 * Human confirmation gate. Returns the `WorldCheck` to append, or null while
 * no human-typed command is available — the placeholder is never applied.
 */
export function confirmCheck(
  proposal: CheckProposal,
  confirmed: { command?: string; expectExit?: number } = {},
): WorldCheck | null {
  const command = (confirmed.command ?? '').replace(/^\s*["']|["']\s*$/g, '').trim();
  if (!command || command === PLACEHOLDER_COMMAND) return null;
  const expectExit =
    typeof confirmed.expectExit === 'number' && Number.isInteger(confirmed.expectExit)
      ? confirmed.expectExit
      : (proposal.suggestedCheck.expectExit ?? 0);
  return { id: proposal.checkId, command, expectExit };
}

/**
 * Notice shown in the turn summary — same shape as `formatPromoteNotice`
 * (promotion.ts), so the two candidate channels read identically.
 */
export function formatCheckProposalNotice(proposal: CheckProposal): string {
  const preview = failureCommandLabel(proposal.command).replace(/\s+/g, ' ').slice(0, 120);
  const suffix = proposal.derivedFromProcedure
    ? `--as-check --command "${proposal.suggestedCheck.command}"`
    : '--as-check --command "<comando>"';
  return `[memory] candidato WorldCheck: “${preview}” (exit ${proposal.exit}) — /memory promote ${proposal.checkId} ${suffix}`;
}

/** How to confirm, or why nothing can be applied yet. */
export function checkConfirmationHint(proposal: CheckProposal): string {
  return proposal.derivedFromProcedure
    ? `[memory] proposta di check (applicazione sempre manuale):\n` +
        `  id: ${proposal.checkId}\n` +
        `  comando suggerito (da procedura verificata): ${proposal.suggestedCheck.command}\n` +
        `  exit atteso: ${proposal.suggestedCheck.expectExit}\n` +
        `  conferma con: /memory promote ${proposal.checkId} --as-check --command "${proposal.suggestedCheck.command}"`
    : `[memory] proposta di check (applicazione sempre manuale):\n` +
        `  id: ${proposal.checkId}\n` +
        `  comando fallito (NON ri-eseguito automaticamente): ${failureCommandLabel(proposal.command)}\n` +
        `  digest: ${proposal.digest} · exit ${proposal.exit}\n` +
        `  nessuna procedura verificata per lo stesso digest: scrivi il comando di regressione,\n` +
        `  conferma con: /memory promote ${proposal.checkId} --as-check --command "<comando>"`;
}
