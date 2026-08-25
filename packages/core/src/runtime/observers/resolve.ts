/**
 * Intervention resolution — semantic precedence when several observers answer
 * the same event. `deny_tool` (hardest) wins over everything; `continue` is the
 * weakest. Ties at the same action are resolved by the bus in descriptor order
 * (lowest priority first); this function only ranks by action kind.
 */
import { CONTINUE } from './types.js';
import type { ObserverResult } from './types.js';

const ACTION_RANK: Record<ObserverResult['action'], number> = {
  deny_tool: 6,
  stop: 5,
  retry: 4,
  replace: 3,
  inject: 2,
  continue: 1,
};

export function resolveInterventions(results: ObserverResult[]): ObserverResult {
  if (results.length === 0) return CONTINUE;
  let best = results[0];
  let bestRank = ACTION_RANK[best.action];
  for (let i = 1; i < results.length; i += 1) {
    const rank = ACTION_RANK[results[i].action];
    if (rank > bestRank) {
      best = results[i];
      bestRank = rank;
    }
  }
  return best;
}
