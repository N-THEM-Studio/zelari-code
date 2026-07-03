/**
 * workspace/completeDesign.ts — Built-in deterministic complete-design
 * fallback (v0.7.8).
 *
 * Guarantees that a design-phase plan is executable even when the council
 * model under-delivered on task emission: every phase in `.zelari/plan.json`
 * ends up with at least {@link MIN_TASKS_PER_PHASE} tasks, and the plan has
 * at least one milestone.
 *
 * This replaces the unversioned per-workspace `complete-design.mjs` script
 * (HANDOFF 2026-07-03 §5.3) for the common case. Unlike that script's
 * hard-coded `TASKS_PER_PHASE` template — whose phase-ID keys drifted from
 * the ids the council actually generated (§4.1: 4 generic tasks instead of
 * 12) — this fallback derives its tasks from the REAL phases in plan.json,
 * so a phase-ID mismatch is impossible by construction.
 *
 * A workspace can still ship its own `complete-design.mjs` with curated
 * domain tasks; when present, `runCompleteDesignPostProcessor` prefers it
 * and this fallback never runs (see postCouncilHook.ts).
 */

import { createWorkspaceStubs, readPlanSummary } from './stubs.js';
import type { WorkspaceContext } from './types.js';

export interface BuiltinCompleteDesignResult {
  /** True when the fallback executed (regardless of how much it added). */
  ran: boolean;
  /** Number of tasks added across all phases. */
  tasksAdded: number;
  /** Number of milestones added (0 or 1). */
  milestonesAdded: number;
  /** Set when ran=false. */
  reason?: string;
}

/** Every phase must end up with at least this many tasks. */
export const MIN_TASKS_PER_PHASE = 3;

interface PhaseLike {
  id: string;
  name?: string;
  description?: string;
}

interface TaskTemplate {
  title: string;
  description: string;
  fileRefs: string[];
  acceptance: string[];
  qaScenario: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * Derive the 3-task backbone for a phase from its own name/description:
 * specify → implement → verify. Grounded in the council artifacts the
 * phase already references (ADRs, design docs, synthesis) so the tasks
 * are actionable without any domain-specific template.
 */
export function curatedTasksForPhase(phase: PhaseLike): TaskTemplate[] {
  const label = (phase.name ?? phase.id).trim();
  const scope = phase.description?.trim()
    ? ` Scope: ${phase.description.trim()}`
    : '';
  return [
    {
      title: `Specify ${label} deliverables`,
      description:
        `Turn the council documents for "${label}" into a concrete specification: enumerate deliverables, ` +
        `interfaces, constraints, and open decisions, grounding each item in the ADRs and design docs ` +
        `already present in .zelari/.${scope}`,
      fileRefs: ['.zelari/docs/', '.zelari/decisions/'],
      acceptance: [
        `A written spec for "${label}" exists and references at least one ADR or design doc`,
        'Every deliverable in the spec has an owner artifact (file, doc, or component) named',
      ],
      qaScenario: `Open the spec for "${label}" and confirm each deliverable maps to a concrete artifact and no open decision is left unresolved.`,
      priority: 'high',
    },
    {
      title: `Implement ${label} deliverables`,
      description:
        `Produce the artifacts the "${label}" phase promises, following the spec task of this phase and ` +
        `the decisions recorded in .zelari/decisions/.${scope}`,
      fileRefs: ['src/'],
      acceptance: [
        `Every deliverable listed in the "${label}" spec exists and builds/renders without errors`,
        'No implementation contradicts an accepted ADR',
      ],
      qaScenario: `Walk the "${label}" spec top to bottom and check each deliverable off against the produced artifact.`,
      priority: 'high',
    },
    {
      title: `Verify ${label} exit criteria`,
      description:
        `Run the QA pass for "${label}": execute the QA scenarios of the phase tasks, check the phase row ` +
        `in the synthesis green-light checklist, and record any gaps as follow-up tasks.${scope}`,
      fileRefs: ['.zelari/docs/synthesis.md'],
      acceptance: [
        `The "${label}" row of the synthesis green-light checklist passes`,
        'All QA scenarios of this phase have been executed with recorded outcomes',
      ],
      qaScenario: `Open .zelari/docs/synthesis.md, locate the "${label}" checklist row, and confirm every criterion is checked with evidence.`,
      priority: 'medium',
    },
  ];
}

/**
 * Ensure every phase has ≥ MIN_TASKS_PER_PHASE tasks and the plan has ≥1
 * milestone. Additive and idempotent: existing tasks/milestones are never
 * modified, and re-running adds nothing once the minimums are met (the
 * generated titles are deterministic and the createTask ids they produce
 * are stable per phase).
 *
 * Creation goes through the same workspace stubs the council uses
 * (createTask / createMilestone), so plan.json, plan.md, and the per-task
 * files stay consistent with model-emitted artifacts.
 */
export async function runBuiltinCompleteDesign(
  ctx: WorkspaceContext,
): Promise<BuiltinCompleteDesignResult> {
  const summary = readPlanSummary(ctx);
  if (summary.phases.length === 0) {
    return { ran: false, tasksAdded: 0, milestonesAdded: 0, reason: 'plan has no phases' };
  }

  const stubs = createWorkspaceStubs(ctx);
  const createTask = stubs.find((s) => s.name === 'createTask')!;
  const createMilestone = stubs.find((s) => s.name === 'createMilestone')!;
  const stubCtx = ctx as unknown as Parameters<typeof createTask.execute>[1];

  let tasksAdded = 0;
  for (const phase of summary.phases) {
    const existingTasks = summary.tasks.filter((t) => t.phaseId === phase.id);
    if (existingTasks.length >= MIN_TASKS_PER_PHASE) continue;
    const existingTitles = new Set(existingTasks.map((t) => t.name ?? ''));
    const templates = curatedTasksForPhase(phase)
      .filter((t) => !existingTitles.has(t.title))
      .slice(0, MIN_TASKS_PER_PHASE - existingTasks.length);
    for (const t of templates) {
      await createTask.execute(
        {
          phaseId: phase.id,
          title: t.title,
          description: t.description,
          fileRefs: t.fileRefs,
          acceptance: t.acceptance,
          qaScenario: t.qaScenario,
          priority: t.priority,
        },
        stubCtx,
      );
      tasksAdded += 1;
    }
  }

  let milestonesAdded = 0;
  if (summary.milestones.length === 0) {
    await createMilestone.execute(
      {
        title: 'v0.1.0 design-complete',
        description:
          'All design-phase artifacts (phases, tasks, ADRs, design docs, risks, synthesis) exist and the green-light checklist passes.',
        targetVersion: 'v0.1.0',
      },
      stubCtx,
    );
    milestonesAdded = 1;
  }

  return { ran: true, tasksAdded, milestonesAdded };
}
