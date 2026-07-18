import type { CouncilRunMode } from './runMode.js';

export const DESIGN_PHASE_MODE_BANNER = `COUNCIL RUN MODE: design-phase.
Workspace tool emissions described in your role prompt are MANDATORY in this run — prose alone does not count as a deliverable. Persist artifacts via the workspace tools listed in your AVAILABLE TOOLS section.`;

export const IMPLEMENTATION_MODE_BANNER = `COUNCIL RUN MODE: implementation.
Prefer write_file, edit_file, and bash for code changes. Design-phase mandatory workspace blocks in your role prompt are INACTIVE — .zelari/docs and draft plans are hypotheses, not product law. Ground work in the real source tree. Only call workspace tools when they add durable project value.`;

/**
 * Implementation-mode banner for the SOLE implementer (the chairman, Lucifero).
 * Only this member writes/edits project files, so the "who implemented" signal
 * stays unambiguous and multiple agents never edit the same files.
 */
export const IMPLEMENTATION_IMPLEMENTER_BANNER = `COUNCIL RUN MODE: implementation — you are the IMPLEMENTER.
You are the only member that writes code this run. Implement the solution with write_file / edit_file and verify with bash. Reconcile specialists' analysis and Minosse's critique into working, verified changes. Design vault (.zelari/docs, draft plans) is HYPOTHESIS only — product truth is the source tree. Design-phase mandatory workspace blocks are INACTIVE.`;

/**
 * Implementation-mode banner for advisors (specialists + Minosse). They analyze,
 * plan and critique; they must NOT modify project files (the implementer does).
 * This prevents multi-writer chaos where several agents edit the same files and
 * pile up conflicting changes.
 */
export const IMPLEMENTATION_ADVISOR_BANNER = `COUNCIL RUN MODE: implementation — you are an ADVISOR.
Do NOT write or edit project files (not via write_file/edit_file, and not via bash) — Lucifero is the sole implementer. Inspect the real codebase (read_file, grep_content, list_files). Treat prior design prose and .zelari/docs as hypotheses. Flag contradictions with package.json / the tree. Design-phase mandatory workspace blocks are INACTIVE.`;

/**
 * Pick the run-mode banner for a member.
 *
 * @param opts.isImplementer  In implementation mode, `true` selects the
 *   implementer banner (chairman/Lucifero), `false` the advisor banner
 *   (specialists + Minosse). Omitted → the legacy generic banner (kept for
 *   backward compatibility with callers that don't distinguish roles).
 */
export function councilModeBanner(
  runMode: CouncilRunMode,
  opts?: { isImplementer?: boolean },
): string {
  if (runMode === 'design-phase') return DESIGN_PHASE_MODE_BANNER;
  if (opts?.isImplementer === true) return IMPLEMENTATION_IMPLEMENTER_BANNER;
  if (opts?.isImplementer === false) return IMPLEMENTATION_ADVISOR_BANNER;
  return IMPLEMENTATION_MODE_BANNER;
}
