import type { CouncilRunMode } from './runMode.js';

export const DESIGN_PHASE_MODE_BANNER = `COUNCIL RUN MODE: design-phase.
Workspace tool emissions described in your role prompt are MANDATORY in this run — prose alone does not count as a deliverable. Persist artifacts via the workspace tools listed in your AVAILABLE TOOLS section.`;

export const IMPLEMENTATION_MODE_BANNER = `COUNCIL RUN MODE: implementation.
Prefer write_file, edit_file, and bash for code changes. Design-phase mandatory workspace blocks in your role prompt are INACTIVE in this run — only call workspace tools when they add durable project value.`;

/**
 * Implementation-mode banner for the SOLE implementer (the chairman, Lucifero).
 * Only this member writes/edits project files, so the "who implemented" signal
 * stays unambiguous and multiple agents never edit the same files.
 */
export const IMPLEMENTATION_IMPLEMENTER_BANNER = `COUNCIL RUN MODE: implementation — you are the IMPLEMENTER.
You are the only member that writes code this run. Implement the solution with write_file / edit_file and verify with bash. Reconcile the specialists' analysis and Minosse's critique into working, verified changes. Design-phase mandatory workspace blocks in your role prompt are INACTIVE — only call workspace tools when they add durable project value.`;

/**
 * Implementation-mode banner for advisors (specialists + Minosse). They analyze,
 * plan and critique; they must NOT modify project files (the implementer does).
 * This prevents multi-writer chaos where several agents edit the same files and
 * pile up conflicting changes.
 */
export const IMPLEMENTATION_ADVISOR_BANNER = `COUNCIL RUN MODE: implementation — you are an ADVISOR.
Do NOT write or edit project files (not via write_file/edit_file, and not via bash) — the final synthesizer (Lucifero) is the sole implementer. Your job is to inspect the codebase (read_file, grep_content, list_files) and produce analysis, a concrete plan, or critique that the implementer will execute. Design-phase mandatory workspace blocks in your role prompt are INACTIVE in this run.`;

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
