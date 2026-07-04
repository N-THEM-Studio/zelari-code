import type { CouncilRunMode } from './runMode.js';

export const DESIGN_PHASE_MODE_BANNER = `COUNCIL RUN MODE: design-phase.
Workspace tool emissions described in your role prompt are MANDATORY in this run — prose alone does not count as a deliverable. Persist artifacts via the workspace tools listed in your AVAILABLE TOOLS section.`;

export const IMPLEMENTATION_MODE_BANNER = `COUNCIL RUN MODE: implementation.
Prefer write_file, edit_file, and bash for code changes. Design-phase mandatory workspace blocks in your role prompt are INACTIVE in this run — only call workspace tools when they add durable project value.`;

export function councilModeBanner(runMode: CouncilRunMode): string {
  return runMode === 'design-phase'
    ? DESIGN_PHASE_MODE_BANNER
    : IMPLEMENTATION_MODE_BANNER;
}
