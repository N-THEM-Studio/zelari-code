/**
 * Repeat-failure helpers (slice 3.2).
 *
 * A failure is identified by a STABLE fingerprint (command + exit code +
 * output digest) so the same breakage always lands on the same memory node
 * instead of growing the graph, and a second sighting of that fingerprint can
 * propose a `constraint` candidate ("stesso fallimento ripetuto").
 *
 * Pure functions only: no memory writes, no AGENTS.md, no lint files.
 */
import { createHash } from 'node:crypto';

/**
 * A constraint proposed by a repeat failure must clear the same bar the
 * `/memory promote` path and the AGENTS.md notices assume
 * (importance >= 0.7 AND confidence >= 0.8) — below it the candidate would be
 * silently un-promotable.
 */
export const CONSTRAINT_IMPORTANCE = 0.72;
export const CONSTRAINT_CONFIDENCE = 0.85;
const MAX_LABEL_CHARS = 200;

/**
 * Stable fingerprint for "same error twice" (slice 3.2).
 *
 * `digest` is the captured-output digest carried by the verification
 * evidence (the engine hashes the command output). Two runs only share a
 * fingerprint when command, exit code AND output are identical — normalize
 * the digest here first if a future slice wants a coarser match.
 */
export function failureFingerprint(command: string, exitCode: number, digest: string): string {
  return createHash('sha256')
    .update(`${command}\0${exitCode}\0${digest}`)
    .digest('hex')
    .slice(0, 24);
}

/** Memory id of the single failure node that owns a fingerprint. */
export function failureNodeId(fingerprint: string): string {
  return `fail-${fingerprint}`;
}

/** Memory id of the constraint a repeated fingerprint promotes to. */
export function constraintNodeId(fingerprint: string): string {
  return `con-${fingerprint}`;
}

/** Evidence refs read like `npm test → exit 1`; keep the command alone. */
export function failureCommandLabel(command: string): string {
  const stripped = command.replace(/\s*(?:→|->)?\s*exit\s+-?\d+\s*$/i, '').trim();
  return (stripped || command.trim()).slice(0, MAX_LABEL_CHARS);
}

/** Deterministic text of the constraint proposed when a failure repeats. */
export function repeatConstraintText(command: string, exitCode: number): string {
  return `Stesso fallimento ripetuto: ${failureCommandLabel(command)} exit ${exitCode}. Considera lint/SKILL/AGENTS.MD.`;
}

/** Exit code recorded in the evidence ref, defaulting to 1 when absent. */
export function guessExitCode(command: string): number {
  const match = command.match(/exit\s+(-?\d+)/i);
  if (!match) return 1;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : 1;
}
