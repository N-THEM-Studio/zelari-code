import type { VerificationCheckResult } from './types.js';

const WRITE_TOOLS = new Set(['write_file', 'edit_file']);

/** Lucifero must emit at least one mutating tool in implementation mode. */
export const IMPLEMENTATION_WRITE_REQUIREMENTS = [
  { name: 'write_file', min: 1 },
  { name: 'edit_file', min: 1 },
] as const;

export interface ImplementationDeliveryCheck {
  ok: boolean;
  missing: string[];
  reason?: string;
}

/**
 * True when at least one write_file/edit_file succeeded (not merely emitted).
 * edit_file counts only when occurrencesReplaced > 0.
 */
export function checkImplementationDelivery(
  successfulWriteCount: number,
  emittedWriteTools: number,
): ImplementationDeliveryCheck {
  if (successfulWriteCount > 0) {
    return { ok: true, missing: [] };
  }
  if (emittedWriteTools > 0) {
    return {
      ok: false,
      missing: ['edit_file'],
      reason:
        'write_file/edit_file ran but no file changed (oldString mismatch or empty write)',
    };
  }
  return {
    ok: false,
    missing: ['write_file', 'edit_file'],
    reason: 'Implementation mode requires at least one successful write_file or edit_file',
  };
}

/** Blocking verify failures the chairman can fix on disk (exclude synthesis meta). */
export function filterDeliveryBlockingFails(
  results: VerificationCheckResult[],
): VerificationCheckResult[] {
  return results.filter(
    (r) =>
      !r.ok &&
      r.severity === 'error' &&
      !r.id.startsWith('synthesis.'),
  );
}

export function buildImplementationWriteRetryPrompt(userMessage: string): string {
  const goal = userMessage.trim().slice(0, 500);
  return (
    `IMPLEMENTATION INCOMPLETE — no file was successfully modified on disk.\n` +
    `User goal: ${goal || '(see council context)'}\n\n` +
    `You MUST implement the requested changes NOW using write_file or edit_file.\n` +
    `Rules:\n` +
    `- read_file the target before edit_file if oldString might have drifted\n` +
    `- Use native tool_call (preferred) or a valid ---TOOLS--- JSON block\n` +
    `- No prose, no verification table — only tool calls until a write succeeds\n` +
    `- Motion: animate ONLY transform and opacity in @keyframes/transitions`
  );
}

/** Imperative fix prompt from deterministic verify FAILs (post-write delivery loop). */
export function buildDeliveryFixPrompt(
  blocking: VerificationCheckResult[],
  userMessage: string,
): string {
  const lines = blocking.map((r) => {
    const file = r.file ? ` (${r.file})` : '';
    return `  - ${r.id}${file}: ${r.message}`;
  });
  const goal = userMessage.trim().slice(0, 300);
  const hints: string[] = [];
  if (blocking.some((r) => r.id === 'inline-js.budget')) {
    hints.push(
      'inline-js.budget: trim the inline <script> by ~1.5KB — remove verbose comments, ' +
        'drop optional JS (tilt/aurora cursor), shorten selectors; keep reveal IO + nav spy',
    );
  }
  if (blocking.some((r) => r.id.startsWith('motion.'))) {
    hints.push(
      'motion.*: @keyframes and transition may use ONLY transform and opacity — ' +
        'grep forbidden props and replace with compositor-safe equivalents',
    );
  }
  return (
    `Deterministic verification still FAILs after your implementation turn. ` +
    `Fix ONLY these blocking issues — do not add features:\n${lines.join('\n')}\n\n` +
    (goal ? `Original user goal (context): ${goal}\n\n` : '') +
    (hints.length > 0 ? `Hints:\n${hints.map((h) => `- ${h}`).join('\n')}\n\n` : '') +
    `Use read_file then edit_file on the listed files. No verification table — tool calls only.`
  );
}

export function countEmittedWriteTools(emittedToolNames: readonly string[]): number {
  return emittedToolNames.filter((t) => WRITE_TOOLS.has(t)).length;
}
