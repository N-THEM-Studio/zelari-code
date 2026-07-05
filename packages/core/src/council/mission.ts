/**
 * Mission classifier — what KIND of work a Zelari-mode mission is.
 *
 * Distinct from `resolveCouncilRunMode` (which decides design-phase vs
 * implementation for a single run): the intent shapes the mission brief and
 * whether the loop auto-chains design → implementation for a greenfield build.
 *
 * Pure and dependency-free (IT + EN keyword heuristics).
 */

export type MissionIntent = 'greenfield' | 'extend' | 'fix' | 'redesign';

export interface ClassifyMissionInput {
  userMessage: string;
  /** True when `.zelari/plan.json` already exists with ≥1 phase. */
  hasPlan?: boolean;
}

const REDESIGN_KEYWORDS =
  /\b(redesign|restyle|restyling|revamp|ridisegna|ridisegnare|nuovo look|rifai la ui|rinnova (?:la )?ui)\b/i;

const FIX_KEYWORDS =
  /\b(fix|bug|hotfix|debug|repair|refactor|patch|correggi|correzione|rifattorizza|refactoring|migra|migrate)\b/i;

const GREENFIELD_KEYWORDS =
  /\b(greenfield|from scratch|scaffold|costruisci|crea|realizza|sviluppa|nuovo progetto|da zero|build (?:a|an|the)? ?(?:new )?)\b/i;

const EXTEND_KEYWORDS =
  /\b(continue|extend|add (?:a )?(?:new )?(?:feature|phase|module)|continua|estendi|aggiungi (?:una )?(?:fase|feature|funzionalit[àa]|modulo))\b/i;

/**
 * Resolve the mission intent.
 *
 * Precedence: extend-on-existing-plan → redesign → greenfield → fix →
 * default (`extend` when a plan exists, otherwise `greenfield`).
 */
export function classifyMission(input: ClassifyMissionInput): MissionIntent {
  const msg = input.userMessage;

  if (input.hasPlan && EXTEND_KEYWORDS.test(msg)) return 'extend';
  if (REDESIGN_KEYWORDS.test(msg)) return 'redesign';
  if (GREENFIELD_KEYWORDS.test(msg)) return 'greenfield';
  if (FIX_KEYWORDS.test(msg)) return 'fix';

  return input.hasPlan ? 'extend' : 'greenfield';
}
