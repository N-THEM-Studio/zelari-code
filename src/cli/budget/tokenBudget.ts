/**
 * tokenBudget — dynamic context spend policy for plan vs build phases.
 *
 * Estimates occupancy from rolling history + session tokens, then:
 *   - soft-warns at 70% of the context limit
 *   - forces compactHistory-style trim at 85% (extractive / optional LLM summary)
 *   - hard-trims to a short tail at 95%
 *
 * Also suggests tool-loop / history-turn caps so plan stays cheaper
 * (more thinking, fewer tool rounds) and build spends more on actions.
 *
 * @since v1.8.0
 * @updated v1.21.0 — continuity summaries on compact; async LLM path
 */

import type { AgentMessage } from '@zelari/core/harness';
import type { WorkPhase } from '../phase.js';
import { envNumber } from '../utils/envNumber.js';
import {
  compactHistoryAsync,
  compactHistoryDetailed,
  type CompactHistoryResult,
} from '../hooks/historyCompaction.js';

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
  /**
   * Continuity summary from the last compaction (extractive or LLM), if any.
   * Empty when no compaction ran.
   */
  compactSummary?: string;
  /** Messages removed by compaction this policy application. */
  messagesRemoved?: number;
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
  // v1.20.0: raised default from 200k → 400k so the rolling history can
  // hold a full multi-step turn (build + smoke + verify + JSON updates)
  // without triggering HARD 95% compaction mid-work. The 85%/95% clamps
  // in applyBudgetPolicy still fire when genuinely needed.
  return envNumber(process.env.ZELARI_CONTEXT_LIMIT, {
    default: 400_000,
    min: 4_000,
    max: 2_000_000,
  });
}

interface PhaseKnobs {
  historyTurns: number;
  maxToolLoopIterations: number;
}

function phaseKnobs(phase: WorkPhase): PhaseKnobs {
  return {
    historyTurns:
      phase === 'plan'
        ? envNumber(process.env.ZELARI_HISTORY_TURNS, { default: 8, min: 0 })
        : envNumber(process.env.ZELARI_HISTORY_TURNS, { default: 6, min: 0 }),
    maxToolLoopIterations:
      phase === 'plan'
        ? envNumber(process.env.ZELARI_MAX_TOOL_LOOP_ITERATIONS, { default: 60, min: 1 })
        : envNumber(process.env.ZELARI_MAX_TOOL_LOOP_ITERATIONS, {
            default: 120,
            min: 1,
          }),
  };
}

function occupancyOf(
  hist: readonly AgentMessage[],
  sessionExtra: number,
  contextLimit: number,
): { estimated: number; occupancy: number } {
  const estimated = estimateHistoryTokens(hist);
  const occupancy = Math.min(1, (estimated + sessionExtra) / contextLimit);
  return { estimated, occupancy };
}

/**
 * Apply phase-aware budget policy to rolling history (sync).
 * Uses extractive continuity summaries — no network.
 * Prefer {@link applyBudgetPolicyAsync} when LLM rewrite is desirable.
 */
export function applyBudgetPolicy(
  history: readonly AgentMessage[],
  phase: WorkPhase,
  opts?: { sessionTokens?: number },
): BudgetPolicy {
  const contextLimit = resolveContextLimit();
  const sessionExtra = opts?.sessionTokens ?? 0;
  const warnings: string[] = [];
  let { historyTurns, maxToolLoopIterations } = phaseKnobs(phase);

  let hist = history as AgentMessage[];
  let { estimated, occupancy } = occupancyOf(hist, sessionExtra, contextLimit);
  let compactSummary = '';
  let messagesRemoved = 0;

  if (occupancy >= 0.7 && occupancy < 0.85) {
    warnings.push(
      `[budget] context ~${Math.round(occupancy * 100)}% full (${estimated + sessionExtra}/${contextLimit} tok est.) — consider /compact or shorter replies.`,
    );
  }

  if (occupancy >= 0.85) {
    const forcedTurns = Math.max(1, Math.floor(historyTurns / 2));
    historyTurns = forcedTurns;
    maxToolLoopIterations = Math.min(
      maxToolLoopIterations,
      phase === 'plan' ? 24 : 40,
    );
    const r = compactHistoryDetailed(hist, { maxMessages: forcedTurns * 4 });
    hist = r.messages;
    if (r.compacted) {
      messagesRemoved += r.messagesRemoved;
      if (r.summary) compactSummary = r.summary;
    }
    ({ estimated, occupancy } = occupancyOf(hist, sessionExtra, contextLimit));
    warnings.push(
      `[budget] auto-compact at 85% — kept ~${forcedTurns} turns (${estimated} tok history est.` +
        (r.messagesRemoved ? `, removed ${r.messagesRemoved} msgs` : '') +
        `).`,
    );
  }

  if (occupancy >= 0.95) {
    const hard = compactHistoryDetailed(hist, { maxMessages: 8 });
    hist = hard.messages;
    if (hard.compacted) {
      messagesRemoved += hard.messagesRemoved;
      if (hard.summary) compactSummary = hard.summary;
    }
    ({ estimated, occupancy } = occupancyOf(hist, sessionExtra, contextLimit));
    historyTurns = 2;
    maxToolLoopIterations = Math.min(maxToolLoopIterations, 16);
    warnings.push(
      `[budget] HARD context pressure (≥95%) — history cut to last ~2 turns with continuity summary. Prefer /clear if quality drops.`,
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
    compactSummary: compactSummary || undefined,
    messagesRemoved: messagesRemoved || undefined,
  };
}

/**
 * Async budget policy: at ≥85% occupancy uses optional LLM continuity brief
 * (ZELARI_LLM_COMPACT, default on), falling back to extractive summary.
 */
export async function applyBudgetPolicyAsync(
  history: readonly AgentMessage[],
  phase: WorkPhase,
  opts?: { sessionTokens?: number; signal?: AbortSignal },
): Promise<BudgetPolicy> {
  const contextLimit = resolveContextLimit();
  const sessionExtra = opts?.sessionTokens ?? 0;
  const warnings: string[] = [];
  let { historyTurns, maxToolLoopIterations } = phaseKnobs(phase);

  let hist = history as AgentMessage[];
  let { estimated, occupancy } = occupancyOf(hist, sessionExtra, contextLimit);
  let compactSummary = '';
  let messagesRemoved = 0;

  if (occupancy >= 0.7 && occupancy < 0.85) {
    warnings.push(
      `[budget] context ~${Math.round(occupancy * 100)}% full (${estimated + sessionExtra}/${contextLimit} tok est.) — consider /compact or shorter replies.`,
    );
  }

  const fold = (r: CompactHistoryResult, label: string, forcedTurns: number) => {
    hist = r.messages;
    if (r.compacted) {
      messagesRemoved += r.messagesRemoved;
      if (r.summary) compactSummary = r.summary;
    }
    ({ estimated, occupancy } = occupancyOf(hist, sessionExtra, contextLimit));
    warnings.push(
      `[budget] ${label} at ${forcedTurns === 2 ? '95%' : '85%'} — kept ~${forcedTurns} turns (${estimated} tok history est.` +
        (r.messagesRemoved ? `, removed ${r.messagesRemoved} msgs` : '') +
        `).`,
    );
  };

  if (occupancy >= 0.85) {
    const forcedTurns = Math.max(1, Math.floor(historyTurns / 2));
    historyTurns = forcedTurns;
    maxToolLoopIterations = Math.min(
      maxToolLoopIterations,
      phase === 'plan' ? 24 : 40,
    );
    const r = await compactHistoryAsync(hist, {
      maxMessages: forcedTurns * 4,
      signal: opts?.signal,
    });
    const label = r.summary.includes('· llm') ? 'llm-compact' : 'auto-compact';
    fold(r, label, forcedTurns);
  }

  if (occupancy >= 0.95) {
    const hard = await compactHistoryAsync(hist, {
      maxMessages: 8,
      signal: opts?.signal,
    });
    fold(hard, hard.summary.includes('· llm') ? 'llm-compact' : 'auto-compact', 2);
    historyTurns = 2;
    maxToolLoopIterations = Math.min(maxToolLoopIterations, 16);
    warnings.push(
      `[budget] HARD context pressure (≥95%) — prefer /clear or a new session if quality drops.`,
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
    compactSummary: compactSummary || undefined,
    messagesRemoved: messagesRemoved || undefined,
  };
}
