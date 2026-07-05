/**
 * Council run-mode detection — implementation vs design-phase.
 *
 * Drives gated tool-emission enforcement, mode banners in member prompts,
 * and the complete-design post-processor skip in implementation runs.
 */

export type CouncilRunMode = 'implementation' | 'design-phase';

export interface CouncilRunModeInput {
  userMessage: string;
  /** True when `.zelari/plan.json` exists with at least one phase. */
  hasExistingPlan?: boolean;
  forceMode?: CouncilRunMode;
  env?: { ZELARI_COUNCIL_MODE?: string };
}

const DESIGN_KEYWORDS =
  /\b(design|architect|architecture|spec|blueprint|mockup|wireframe|greenfield|from scratch|costruisci|crea|progetta|progettazione|architettura|nuovo progetto|da zero|sviluppa|realizza|vetrina|pannello|gestionale)\b/i;

// NB: bare Italian "sistema" (the noun "system") is deliberately excluded —
// it collides with greenfield prompts like "costruisci un sistema gestionale".
// Only unambiguous fix verbs are listed.
const IMPLEMENTATION_KEYWORDS =
  /\b(fix|refactor|bug|implement|patch|migrate|add tests|debug|repair|hotfix|correggi|correzione|rifattorizza|refactoring|implementa|aggiungi test|migra)\b/i;

const PLAN_CONTINUE =
  /\b(continue|extend|update|refine|continua|estendi|aggiorna|rifinisci)\b[\s\S]{0,40}\b(plan|phase|milestone|piano|fase|milestone)\b/i;

/**
 * Resolve how this council run should behave.
 *
 * Override order: `forceMode` → `ZELARI_COUNCIL_MODE` env → heuristics →
 * default `implementation`.
 */
export function resolveCouncilRunMode(input: CouncilRunModeInput): CouncilRunMode {
  if (input.forceMode) {
    return input.forceMode;
  }

  const envMode = input.env?.ZELARI_COUNCIL_MODE?.toLowerCase();
  if (envMode === 'design' || envMode === 'design-phase') {
    return 'design-phase';
  }
  if (envMode === 'implementation' || envMode === 'impl') {
    return 'implementation';
  }

  const msg = input.userMessage;
  const hasDesign = DESIGN_KEYWORDS.test(msg);
  const hasImpl = IMPLEMENTATION_KEYWORDS.test(msg);

  if (hasDesign && !hasImpl) {
    return 'design-phase';
  }
  if (PLAN_CONTINUE.test(msg) && input.hasExistingPlan) {
    return 'design-phase';
  }

  return 'implementation';
}

export function councilTierFromSize(councilSize: number): 'lite' | 'full' {
  return councilSize >= 6 ? 'full' : 'lite';
}
