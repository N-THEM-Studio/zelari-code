/**
 * phase — work phase orthogonal to dispatch mode (kraken/council/zelari).
 *
 *   plan  — explore + design only; no project-file writes (plan artifacts ok)
 *   build — full tools; implement (optionally from an existing plan)
 *
 * Toggled via /plan and /build. Independent of shift+tab dispatch mode so
 * you can run "council + plan" or "agent + build" without a 6-way cycle.
 *
 * @since v1.8.0
 */

export type WorkPhase = 'plan' | 'build';

export const PHASES: readonly WorkPhase[] = ['plan', 'build'] as const;

export function parsePhase(input: string): WorkPhase | null {
  const v = input.trim().toLowerCase();
  return (PHASES as readonly string[]).includes(v) ? (v as WorkPhase) : null;
}

export function nextPhase(current: WorkPhase): WorkPhase {
  return current === 'plan' ? 'build' : 'plan';
}

export function describePhase(phase: WorkPhase): string {
  switch (phase) {
    case 'plan':
      return 'plan — explore & design only (no project writes; plan files allowed)';
    default:
      return 'build — implement with full tools';
  }
}

/**
 * Tools allowed to mutate the filesystem while phase === 'plan'.
 * Everything else with write/execute permissions is stripped from the
 * registry (or blocked at invoke time).
 */
export const PLAN_ALLOWED_WRITE_TOOLS = new Set([
  // Workspace plan/docs — intentional plan-mode outputs
  'createPlan',
  'createTask',
  'updateTask',
  'createMilestone',
  'createDocument',
  'createDecision',
  'linkDocuments',
  // Soft writes that only touch .zelari / plan paths are still gated in
  // toolRegistry by path when needed; write_file/edit_file stay DENIED.
]);

/** Builtin tools that must never run in plan phase. */
export const PLAN_BLOCKED_TOOLS = new Set([
  'write_file',
  'edit_file',
  'apply_diff',
  'bash',
]);
