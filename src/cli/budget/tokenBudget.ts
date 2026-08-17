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
  pruneToolResultsDetailed,
  type CompactHistoryResult,
} from '../hooks/historyCompaction.js';
import type { RoutedRequestSnapshot, ProviderStreamFn, AgentToolSpec } from '@zelari/core/harness';
import type { StoredRequestUsage } from './requestSnapshotStore.js';
import { applySessionSurface } from '../hooks/observationStore.js';
import { capabilitiesFor } from '../provider/capabilities.js';

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
  /**
   * v1.36.0: full-request pressure (header + conversation + reserved
   * output). Present only when a request snapshot anchored the meter.
   */
  contextPressureTokens?: number;
  /** v1.36.0: true when the compaction replayed the original prefix. */
  cacheReuseExpected?: boolean;
  /** v1.36.0: human-readable cache telemetry line (fingerprints/occupancy). */
  cacheMetricsLine?: string;
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

/**
 * Model-aware default context window. DeepSeek v4 ships a 1M context
 * (docs: 1M ctx, 384K max out) — treating it as 400k forces premature
 * compaction that rewrites the history prefix and busts the server-side
 * prefix cache. ZELARI_CONTEXT_LIMIT always wins when set.
 */
export function defaultContextLimitForModel(model?: string): number {
  return capabilitiesFor(model).contextWindow;
}

export function resolveContextLimit(model?: string): number {
  // v1.20.0: raised default from 200k → 400k so the rolling history can
  // hold a full multi-step turn (build + smoke + verify + JSON updates)
  // without triggering HARD 95% compaction mid-work. The 85%/95% clamps
  // in applyBudgetPolicy still fire when genuinely needed.
  // v1.35.x: model-aware default — DeepSeek v4 uses 1M.
  return envNumber(process.env.ZELARI_CONTEXT_LIMIT, {
    default: defaultContextLimitForModel(model),
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
  opts?: { sessionTokens?: number; model?: string },
): BudgetPolicy {
  const contextLimit = resolveContextLimit(opts?.model);
  const compact = capabilitiesFor(opts?.model).compaction;

  const sessionExtra = opts?.sessionTokens ?? 0;
  const warnings: string[] = [];
  let { historyTurns, maxToolLoopIterations } = phaseKnobs(phase);

  let hist = history as AgentMessage[];
  let { estimated, occupancy } = occupancyOf(hist, sessionExtra, contextLimit);
  let compactSummary = '';
  let messagesRemoved = 0;

  if (occupancy >= compact.warnAt && occupancy < compact.compactAt) {
    warnings.push(
      `[budget] context ~${Math.round(occupancy * 100)}% full (${estimated + sessionExtra}/${contextLimit} tok est.) — consider /compact or shorter replies.`,
    );
  }

  if (occupancy >= compact.compactAt) {
    const forcedTurns = Math.max(1, Math.floor(historyTurns / 2));
    historyTurns = forcedTurns;
    maxToolLoopIterations = Math.min(
      maxToolLoopIterations,
      phase === 'plan' ? 24 : 40,
    );
    const r = compactHistoryDetailed(hist, { maxMessages: forcedTurns * 4 });
    hist = applySessionSurface(r.messages);
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

  if (occupancy >= compact.hardAt) {
    const hard = compactHistoryDetailed(hist, { maxMessages: 8 });
    hist = applySessionSurface(hard.messages);
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
/**
 * Envelope for the v1.36.0 cache-aware pipeline. All fields optional so
 * legacy callers (council path, tests) keep working unchanged.
 */
export interface BudgetPolicyEnvelope {
  sessionTokens?: number;
  signal?: AbortSignal;
  model?: string;
  sessionId?: string;
  /** Last routed request snapshot + provider usage (requestSnapshotStore). */
  requestSnapshot?: {
    snapshot: RoutedRequestSnapshot;
    usage?: StoredRequestUsage;
  } | null;
  /** Provider stream for cache-aware compaction replay. */
  providerStream?: ProviderStreamFn;
}

/** Reserved output headroom factored into context pressure (v1.36.0). */
const RESERVED_OUTPUT_TOKENS = 8_192;

/**
 * Async budget policy — v1.36.0 pipeline (P6/P7):
 *
 *   measure → 70–85% warn
 *          → ≥80% prune oversized tool results → remeasure
 *          → ≥85% compactHistoryAsync(force, replay) → remeasure
 *          → ≥95% emergency hard trim → send
 *
 * Measuring uses the FULL request surface (system + tools schema +
 * conversation + reasoning) when a snapshot anchors it; otherwise it falls
 * back to the legacy history-only estimate. Pruning BEFORE summarizing
 * avoids an LLM compaction call entirely when two oversized read_file /
 * grep results were the whole problem (DSH prune-remeasure lesson).
 *
 * cachedPromptTokens are NEVER subtracted from pressure: cached or not,
 * the provider still holds the whole prefix in the context window.
 */
export async function applyBudgetPolicyAsync(
  history: readonly AgentMessage[],
  phase: WorkPhase,
  opts?: BudgetPolicyEnvelope,
): Promise<BudgetPolicy> {
  const contextLimit = resolveContextLimit(opts?.model);
  const compact = capabilitiesFor(opts?.model).compaction;

  const sessionExtra = opts?.sessionTokens ?? 0;
  const warnings: string[] = [];
  let { historyTurns, maxToolLoopIterations } = phaseKnobs(phase);

  const envelope = opts?.requestSnapshot ?? null;
  // v1.36.0 (case 12): when only the providerStream is available (no routed
  // snapshot yet — first turn, tests), synthesize a DEGRADED replay base so
  // the summarizer still runs on a cold minimal prefix: no cache reuse, but
  // LLM compaction proceeds instead of being silently skipped. The METER
  // stays anchored to real snapshots only (a degraded envelope would add
  // RESERVED_OUTPUT_TOKENS pressure that was never measured).
  const replayBase: {
    provider: string;
    model: string;
    systemMessages: readonly AgentMessage[];
    tools: readonly AgentToolSpec[];
  } | null = envelope
    ? {
        provider: envelope.snapshot.provider,
        model: envelope.snapshot.model,
        systemMessages: envelope.snapshot.systemMessages,
        tools: envelope.snapshot.tools,
      }
    : opts?.providerStream
      ? { provider: 'local', model: opts?.model ?? 'unknown', systemMessages: [], tools: [] }
      : null;

  // Full-request meter (anchored when snapshot+usage are available).
  const headerTokens = envelope
    ? estimateSystemTokensLite(envelope.snapshot.systemMessages) +
      estimateToolSchemaTokensLite(envelope.snapshot.tools)
    : 0;
  const convTokensOf = (h: readonly AgentMessage[]) =>
    estimateConversationTokensLite(h);

  let hist = history as AgentMessage[];
  let estimated = envelope
    ? headerTokens + convTokensOf(hist) + RESERVED_OUTPUT_TOKENS
    : estimateHistoryTokens(hist) + sessionExtra;
  let occupancy = Math.min(1, estimated / contextLimit);
  let compactSummary = '';
  let messagesRemoved = 0;
  let cacheReuseExpected: boolean | undefined;
  let prunedTotal = 0;

  if (occupancy >= compact.warnAt && occupancy < compact.compactAt) {
    warnings.push(
      `[budget] context ~${Math.round(occupancy * 100)}% full (${estimated}/${contextLimit} tok full-request est.) — consider /compact or shorter replies.`,
    );
  }

  // ── ≥80%: prune oversized tool results, then REMEASURE ──────────────────
  if (occupancy >= 0.8) {
    const pruned = pruneToolResultsDetailed(hist);
    if (pruned.stats.pruned > 0) {
      hist = pruned.messages;
      prunedTotal += pruned.stats.pruned;
      estimated = envelope
        ? headerTokens + convTokensOf(hist) + RESERVED_OUTPUT_TOKENS
        : estimateHistoryTokens(hist) + sessionExtra;
      occupancy = Math.min(1, estimated / contextLimit);
      warnings.push(
        `[budget] pruned ${pruned.stats.pruned} oversized tool result(s) → ${Math.round(occupancy * 100)}% (${estimated} tok).`,
      );
    }
  }

  const fold = (r: CompactHistoryResult, label: string, forcedTurns: number) => {
    hist = applySessionSurface(r.messages);
    if (r.compacted) {
      messagesRemoved += r.messagesRemoved;
      if (r.summary) compactSummary = r.summary;
      if (r.cacheReuseExpected !== undefined) {
        cacheReuseExpected = r.cacheReuseExpected;
      }
    }
    estimated = envelope
      ? headerTokens + convTokensOf(hist) + RESERVED_OUTPUT_TOKENS
      : estimateHistoryTokens(hist) + sessionExtra;
    occupancy = Math.min(1, estimated / contextLimit);
    warnings.push(
      `[budget] ${label} — kept ~${forcedTurns} turns (${estimated} tok est.` +
        (r.messagesRemoved ? `, removed ${r.messagesRemoved} msgs` : '') +
        (r.cacheReuseExpected === false ? ', cache reuse NOT expected (model override)' : '') +
        ').',
    );
  };

  // ── ≥85% after pruning: cache-aware compaction (replay when possible) ───
  if (occupancy >= compact.compactAt) {
    const forcedTurns = Math.max(1, Math.floor(historyTurns / 2));
    historyTurns = forcedTurns;
    maxToolLoopIterations = Math.min(
      maxToolLoopIterations,
      phase === 'plan' ? 24 : 40,
    );
    let r = await compactHistoryAsync(hist, {
      maxMessages: Math.max(2, forcedTurns * 4),
      force: true,
      signal: opts?.signal,
      ...(replayBase
        ? { requestSnapshot: replayBase, providerStream: opts?.providerStream }
        : {}),
    });
    // Few-but-huge histories may not shrink on the first window: retry
    // with a minimal window so token pressure always wins (test case 20).
    if (!r.compacted) {
      r = await compactHistoryAsync(hist, {
        maxMessages: 2,
        force: true,
        signal: opts?.signal,
        ...(replayBase
          ? { requestSnapshot: replayBase, providerStream: opts?.providerStream }
          : {}),
      });
    }
    const label = r.cacheReuseExpected === false ? 'llm-compact (model override)' : 'auto-compact';
    fold(r, label, forcedTurns);
  }

  // ── ≥95%: emergency hard trim ────────────────────────────────────────────
  if (occupancy >= compact.hardAt) {
    const hard = await compactHistoryAsync(hist, {
      maxMessages: 2,
      force: true,
      signal: opts?.signal,
    });
    fold(hard, hard.summary.includes('· llm') ? 'llm-compact' : 'HARD trim', 2);
    historyTurns = 2;
    maxToolLoopIterations = Math.min(maxToolLoopIterations, 16);
    warnings.push(
      '[budget] HARD context pressure (≥95%) — prefer /clear or a new session if quality drops.',
    );
  }

  const cacheMetricsLine = envelope
    ? [
        'compaction meter:',
        `provider/model: ${envelope.snapshot.provider}/${envelope.snapshot.model}`,
        `headerFingerprint: ${envelope.snapshot.headerFingerprint.slice(0, 12)}`,
        `occupancy: ${Math.round(occupancy * 100)}% (${estimated}/${contextLimit})`,
        ...(envelope.usage?.cachedPromptTokens !== undefined
          ? [`cachedPromptTokens: ${envelope.usage.cachedPromptTokens}`]
          : []),
        ...(cacheReuseExpected !== undefined
          ? [`cacheReuseExpected: ${cacheReuseExpected}`]
          : []),
      ].join(' | ')
    : undefined;

  return {
    history: hist,
    warnings,
    maxToolLoopIterations,
    historyTurns,
    estimatedHistoryTokens: envelope ? convTokensOf(hist) : estimated,
    contextLimit,
    occupancy,
    compactSummary: compactSummary || undefined,
    messagesRemoved: messagesRemoved || undefined,
    ...(envelope ? { contextPressureTokens: estimated } : {}),
    ...(cacheReuseExpected !== undefined ? { cacheReuseExpected } : {}),
    ...(cacheMetricsLine ? { cacheMetricsLine } : {}),
  };
}

// ── Local estimators (requestMeter-lite, no import cycle) ───────────────────

function estimateSystemTokensLite(
  systemMessages: readonly AgentMessage[],
): number {
  let n = 0;
  for (const m of systemMessages) n += 4 + Math.ceil((m.content ?? '').length / 4);
  return n;
}

function estimateToolSchemaTokensLite(
  tools: readonly { name: string; description?: string; parameters?: unknown }[],
): number {
  let n = 0;
  for (const t of tools) {
    n += Math.ceil((t.name ?? '').length / 4);
    n += Math.ceil((t.description ?? '').length / 4);
    n += Math.ceil(JSON.stringify(t.parameters ?? {}).length / 4);
  }
  return n + tools.length * 4;
}

function estimateConversationTokensLite(
  messages: readonly AgentMessage[],
): number {
  let n = 0;
  for (const m of messages) {
    n += 4 + Math.ceil((m.content ?? '').length / 4);
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        n += Math.ceil(tc.name.length / 4) + Math.ceil(tc.id.length / 4);
        n += Math.ceil(JSON.stringify(tc.args ?? {}).length / 4);
      }
    }
    if (m.reasoningContent) n += Math.ceil(m.reasoningContent.length / 4);
    if (m.toolCallId) n += Math.ceil(m.toolCallId.length / 4);
  }
  return n;
}
