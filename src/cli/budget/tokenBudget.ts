/**
 * tokenBudget — dynamic context spend policy for plan vs build phases.
 *
 * Estimates occupancy from rolling history + session tokens, then:
 *   - soft-warns at 70% of the context limit
 *   - forces compactHistory-style trim at 85%
 *   - hard-trims to a short tail at 95%
 *
 * Also suggests tool-loop / history-turn caps so plan stays cheaper
 * (more thinking, fewer tool rounds) and build spends more on actions.
 *
 * @since v1.8.0
 */

import type { AgentMessage } from '@zelari/core/harness';
import type { WorkPhase } from '../phase.js';
import { envNumber } from '../utils/envNumber.js';
import { compactHistory } from '../hooks/historyCompaction.js';

export interface BudgetPolicy {
  /** Possibly compacted history. */
  history: AgentMessage[];
  /** Human-readable warnings for the TUI (empty when fine). */
  warnings: string[];
  /** Suggested max tool-loop iterations for this turn. */
  maxToolLoopIterations: number;
  /** Suggested history-turn window (for next compact). */
  historyTurns: number;
  /** Estimated tokens currently used by history. */
  estimatedHistoryTokens: number;
  /** Context window limit used for ratios. */
  contextLimit: number;
  /** 0–1 occupancy of history vs limit. */
  occupancy: number;
}

/** Rough chars→tokens (OpenAI-ish). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateHistoryTokens(messages: readonly AgentMessage[]): number {
  let n = 0;
  for (const m of messages) {
    n += estimateTokens(m.content);
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        n += estimateTokens(tc.name) + estimateTokens(JSON.stringify(tc.args ?? {}));
      }
    }
  }
  return n;
}

export function resolveContextLimit(): number {
  return envNumber(process.env.ZELARI_CONTEXT_LIMIT, {
    default: 200_000,
    min: 4_000,
    max: 2_000_000,
  });
}

/**
 * Apply phase-aware budget policy to rolling history.
 * Pure: does not mutate the global conversationContext.
 */
export function applyBudgetPolicy(
  history: readonly AgentMessage[],
  phase: WorkPhase,
  opts?: { sessionTokens?: number },
): BudgetPolicy {
  const contextLimit = resolveContextLimit();
  const warnings: string[] = [];

  // Base knobs by phase.
  let historyTurns =
    phase === 'plan'
      ? envNumber(process.env.ZELARI_HISTORY_TURNS, { default: 8, min: 0 })
      : envNumber(process.env.ZELARI_HISTORY_TURNS, { default: 6, min: 0 });
  let maxToolLoopIterations =
    phase === 'plan'
      ? envNumber(process.env.ZELARI_MAX_TOOL_LOOP_ITERATIONS, { default: 40, min: 1 })
      : envNumber(process.env.ZELARI_MAX_TOOL_LOOP_ITERATIONS, { default: 90, min: 1 });

  let hist = history as AgentMessage[];
  let estimated = estimateHistoryTokens(hist);
  const sessionExtra = opts?.sessionTokens ?? 0;
  let occupancy = Math.min(1, (estimated + sessionExtra) / contextLimit);

  if (occupancy >= 0.7 && occupancy < 0.85) {
    warnings.push(
      `[budget] context ~${Math.round(occupancy * 100)}% full (${estimated + sessionExtra}/${contextLimit} tok est.) — consider /compact or shorter replies.`,
    );
  }

  if (occupancy >= 0.85) {
    // Force aggressive compaction (half the normal turn window).
    const forcedTurns = Math.max(1, Math.floor(historyTurns / 2));
    historyTurns = forcedTurns;
    hist = compactHistory(hist, { maxMessages: forcedTurns * 4 });
    estimated = estimateHistoryTokens(hist);
    occupancy = Math.min(1, (estimated + sessionExtra) / contextLimit);
    warnings.push(
      `[budget] auto-compact at 85% — kept ~${forcedTurns} turns (${estimated} tok history est.).`,
    );
    // Prefer fewer tool rounds when cramped.
    maxToolLoopIterations = Math.min(maxToolLoopIterations, phase === 'plan' ? 24 : 40);
  }

  if (occupancy >= 0.95) {
    // Hard tail: keep only last 2 turns (~8 messages).
    hist = compactHistory(hist, { maxMessages: 8 });
    estimated = estimateHistoryTokens(hist);
    occupancy = Math.min(1, (estimated + sessionExtra) / contextLimit);
    historyTurns = 2;
    maxToolLoopIterations = Math.min(maxToolLoopIterations, 16);
    warnings.push(
      `[budget] HARD context pressure (≥95%) — history cut to last ~2 turns. Prefer /clear or a new session if quality drops.`,
    );
  }

  return {
    history: hist,
    warnings,
    maxToolLoopIterations,
    historyTurns,
    estimatedHistoryTokens: estimated,
    contextLimit,
    occupancy,
  };
}
