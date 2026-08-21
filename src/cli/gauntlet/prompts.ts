/**
 * Builder / critic prompts for the host-driven Gauntlet loop.
 * Critic isolation is mechanical (fresh tentacle); the text must not
 * include the builder's chain-of-thought.
 */
import { qualityBarSection } from './blind.js';
import type { GauntletPiece } from './decompose.js';

export const GAUNTLET_CRITIC_SYSTEM = [
  'You are a ruthless VERIFY critic in a Gauntlet Loop.',
  'Inspect the REAL files and commands on disk. Do not trust a builder self-report.',
  'You have no builder transcript — only the Goal, Scope, Acceptance, and the tree.',
  'OBSERVATION INTEGRITY: unknown ≠ pass. EMPTY/degraded tools are not evidence.',
  'Name at most ONE biggest remaining gap. Do not write a laundry list.',
  'You may read files and run test/build commands via bash. Prefer targeted checks.',
  '',
  'End with BOTH:',
  '1. One <verify-report> block per acceptance criterion:',
  '<verify-report>',
  'check: <criterion text as given>',
  'status: pass | fail | unknown',
  'note: <one line of evidence (command or file + outcome)>',
  '</verify-report>',
  '2. A trailer on its own lines:',
  'VERDICT: PASS | GAP | BLOCKED',
  'GAP: <single biggest remaining gap; omit on PASS>',
  '3. If a Blind A/B section is present, also emit WINNER: A | B | TIE',
].join('\n');

export function builderUserPrompt(
  piece: GauntletPiece,
  gap?: string,
  briefing?: string,
): string {
  const parts = [
    `You are the BUILDER for one Gauntlet piece. Implement it on disk.`,
    `Do not spawn sub-agents. Stay inside Scope if provided.`,
  ];
  if (briefing?.trim()) {
    parts.push('', '## Workspace briefing (do not treat as already-done work)', briefing.trim());
  }
  parts.push('', `## Piece: ${piece.label}`, piece.prompt.trim());
  if (piece.scope && piece.scope.length > 0) {
    parts.push('', '## Scope', ...piece.scope.map((s) => `- ${s}`));
  }
  if (piece.acceptance.length > 0) {
    parts.push('', '## Acceptance', ...piece.acceptance.map((a) => `- ${a}`));
  }
  if (gap && gap.trim()) {
    parts.push(
      '',
      '## Previous critic GAP (fix ONLY this)',
      gap.trim(),
      'Do not widen scope. Re-check the acceptance after the fix.',
    );
  }
  parts.push('', 'Return: files touched, what changed, residual risks.');
  return parts.join('\n');
}

export function criticUserPrompt(
  piece: GauntletPiece,
  round: number,
  rand?: () => number,
): string {
  const parts = [
    `Round ${round}. Inspect the current tree against this piece.`,
    'Do not edit files. Do not take the builder\'s word — open files / run checks.',
    '',
    `## Piece: ${piece.label}`,
    piece.prompt.trim(),
  ];
  if (piece.scope && piece.scope.length > 0) {
    parts.push('', '## Scope', ...piece.scope.map((s) => `- ${s}`));
  }
  if (piece.acceptance.length > 0) {
    parts.push('', '## Acceptance (check each)', ...piece.acceptance.map((a) => `- ${a}`));
  } else {
    parts.push(
      '',
      '## Acceptance',
      '- The piece prompt is satisfied by files on disk.',
      '- Relevant typecheck/tests pass when the project has them.',
    );
  }
  const bar = qualityBarSection(piece.bar, rand);
  if (bar) parts.push('', bar);
  return parts.join('\n');
}
