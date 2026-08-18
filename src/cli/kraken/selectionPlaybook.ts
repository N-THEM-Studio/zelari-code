import { KRAKEN_SELECTION_PLAYBOOK_MODULE } from '@zelari/core/skills';
import type { SystemPromptModule } from '@zelari/core/skills';
import { isKrakenSelectionEnabled } from './candidateRegistry.js';

/**
 * Adaptive Verified-Selection playbook (plan §53).
 *
 * Returns the selection playbook module for the Kraken parent prompt when
 * BOTH the call site wants it (standard Kraken paths only — never Zelari
 * mission slices) and the alpha feature flag `ZELARI_KRAKEN_SELECTION=1`
 * is enabled. Flag off ⇒ the parent prompt stays byte-identical to
 * today's (regression guard §65).
 *
 * The playbook teaches WHEN to explore candidates (simple → direct,
 * ambiguous → 2, high uncertainty → 3) and the discipline around
 * kraken_select; the candidate-side instructions (report format,
 * diversity, integrity) live in the task tool's candidate
 * systemPromptOverride (Fase 3).
 */
export function krakenSelectionPlaybook(include: boolean): SystemPromptModule[] {
  if (!include || !isKrakenSelectionEnabled()) return [];
  return [KRAKEN_SELECTION_PLAYBOOK_MODULE];
}
