/**
 * historyCompaction — Rolling-history compaction for the single-agent chat loop.
 *
 * The single-agent loop (useChatTurn) keeps an in-memory `AgentMessage[]`
 * accumulator so the model sees its own prior turns (the clarifying-question
 * fix depends on this). Left unchecked, that array grows without bound and
 * eventually blows the provider's context window. This module trims it.
 *
 * Strategy: count-based sliding window with ONE hard invariant — never split
 * an `assistant(tool_calls) → tool(result)` chain. The OpenAI chat schema
 * requires every `role:'tool'` message to be preceded by the assistant turn
 * that declared the matching `tool_calls`; strict providers (MiniMax/GLM)
 * return HTTP 400 otherwise (see core-agentHarness-toolResultOrder.test.ts).
 * So when the naive cut point lands between an assistant-with-toolCalls and
 * its tool results, the window is extended backward to include the whole
 * chain.
 *
 * v1.21.0: dropped turns are replaced by an extractive (and optionally LLM)
 * continuity summary instead of a bare "N messages dropped" marker.
 *
 * Tunable via `ZELARI_HISTORY_TURNS` (number of kept *turns*; default 6,
 * `0` disables history entirely → the loop falls back to the pre-1.6
 * stateless `[system, user]` behavior).
 *
 * @since v1.6.0
 */

import type { AgentMessage, AgentToolSpec } from "@zelari/core/harness";
import {
  extractiveHistorySummary,
  formatDroppedForLlm,
} from "../budget/historySummary.js";
import {
  llmSummarizeHistoryReplay,
  type LlmSummarizeReplayResult,
} from "../budget/llmCompact.js";
import { envNumber } from "../utils/envNumber.js";

export interface CompactHistoryOptions {
  /**
   * v1.36.0 (P8): bypass the `2 × maxMessages` message-count gate. The
   * occupancy-driven budget pipeline calls with force when TOKEN pressure
   * is high even with few (huge) messages. Default false preserves the
   * legacy amortized behavior for count-based callers.
   */
  force?: boolean;
  /**
   * Max number of messages to keep after compaction. When the accumulator
   * exceeds `2 * maxMessages`, the oldest messages are dropped (subject to
   * the tool-chain atomicity rule). Default derived from
   * `ZELARI_HISTORY_TURNS` (default 6 → ~24 messages at 4 msg/turn).
   */
  maxMessages?: number;
  /**
   * When durable state HEAD exists, prefer a tighter window — verified
   * discoveries live on disk (Palmer), so transcript can be shorter (cheaper).
   */
  durableStatePresent?: boolean;
}

/** Marker prepended when messages are dropped (legacy short form). */
const COMPACT_MARKER = "[history] Earlier turns were compacted to stay within the context budget.";

export interface CompactHistoryResult {
  messages: AgentMessage[];
  /** True when messages were actually rewritten/truncated. */
  compacted: boolean;
  messagesRemoved: number;
  summary: string;
  /** Tool results pruned in-place (head/tail) to preserve the cache prefix. */
  prunedToolResults?: number;
  /** v1.36.0: replayed the original prefix → provider cache reuse expected. */
  cacheReuseExpected?: boolean;
  /** v1.36.0: replay diverged from the original prefix (telemetry only). */
  replayExactPrefix?: boolean;
  /** Closed spine range replaced by the checkpoint (absent without seqs). */
  fromSeq?: number;
  toSeq?: number;
  sourceEventSeqs?: number[];
  strategy?: 'extractive' | 'llm';
}

/** Min/max spine seq of dropped messages. Undefined when any dropped msg lacks seq. */
export function compactedRangeFromDropped(
  dropped: readonly AgentMessage[],
): { fromSeq: number; toSeq: number; sourceEventSeqs: number[] } | undefined {
  if (dropped.length === 0) return undefined;
  const seqs: number[] = [];
  const sources: number[] = [];
  for (const m of dropped) {
    const hasCompactRange =
      typeof m.compactedFromSeq === 'number' &&
      Number.isInteger(m.compactedFromSeq) &&
      m.compactedFromSeq > 0 &&
      typeof m.compactedToSeq === 'number' &&
      Number.isInteger(m.compactedToSeq) &&
      m.compactedToSeq >= m.compactedFromSeq;
    if (hasCompactRange) {
      seqs.push(m.compactedFromSeq!, m.compactedToSeq!);
      sources.push(...(m.sourceEventSeqs ?? []));
      if (typeof m.seq === 'number' && Number.isInteger(m.seq) && m.seq > 0) {
        seqs.push(m.seq);
        sources.push(m.seq);
      }
      continue;
    }
    if (typeof m.seq !== 'number' || !Number.isInteger(m.seq) || m.seq < 1) return undefined;
    seqs.push(m.seq);
    sources.push(m.seq);
  }
  return {
    fromSeq: Math.min(...seqs),
    toSeq: Math.max(...seqs),
    sourceEventSeqs: [...new Set(sources)],
  };
}

function withDroppedRange(
  result: CompactHistoryResult,
  dropped: readonly AgentMessage[],
  strategy: 'extractive' | 'llm',
): CompactHistoryResult {
  const range = compactedRangeFromDropped(dropped);
  if (!range) return { ...result, strategy };
  return { ...result, ...range, strategy };
}

/**
 * Resolve the effective max-messages cap from options or the env var.
 * Returns 0 to signal "history disabled" (caller should short-circuit).
 */
export function resolveMaxMessages(opts?: CompactHistoryOptions): number {
  // v2.32.0 (S3 "adult history"): the DEFAULT count cap is a high safety
  // net (40 turns ≈ 160 messages) — the primary gate is now the adaptive
  // character budget (resolveHistoryCharBudget). min 0 stays because
  // ZELARI_HISTORY_TURNS=0 legitimately means "disable history" — the
  // pre-1.6 stateless fallback — and must NOT be coerced to a non-zero
  // default on a typo.
  const envTurns = envNumber(process.env.ZELARI_HISTORY_TURNS, { default: 40, min: 0 });
  // opts override env; an EXPLICIT env is a user contract, the default is
  // only a runaway safety net on top of the char gate.
  let turns = opts?.maxMessages ? Math.ceil(opts.maxMessages / 4) : envTurns;
  if (turns <= 0) return 0;
  // v1.36.0 (P8/case 20): occupancy-driven callers (force=true) pass a
  // PRECISE message window — honor it literally instead of rounding through
  // the turns×4 amortization, which would inflate a small window (2 → 4)
  // and refuse to drop anything. The ×4 rounding stays for the count-gated
  // legacy path where it amortizes compaction across turns.
  if (opts?.force && opts?.maxMessages) return Math.max(1, opts.maxMessages);
  return turns * 4;
}

/**
 * v2.32.0 (S3): the PRIMARY history gate — an adaptive character budget
 * (~20k chars ≈ 5k tokens) instead of the legacy count-based default.
 * Tunable via `ZELARI_HISTORY_BUDGET_CHARS` (min 2k, max 200k). With
 * durable state present and no explicit env, the budget halves: verified
 * discoveries live on disk (Palmer), so the transcript can stay lean.
 */
export function resolveHistoryCharBudget(
  opts?: Pick<CompactHistoryOptions, 'durableStatePresent'>,
): number {
  const halveForDurable =
    !!opts?.durableStatePresent && process.env.ZELARI_HISTORY_BUDGET_CHARS === undefined;
  return envNumber(process.env.ZELARI_HISTORY_BUDGET_CHARS, {
    default: halveForDurable ? 10_000 : 20_000,
    min: 2_000,
    max: 200_000,
  });
}

/** Total content chars of a message list — the S3 gate metric. */
export function historyChars(messages: readonly AgentMessage[]): number {
  let n = 0;
  for (const m of messages) n += (m.content ?? '').length;
  return n;
}

/**
 * Find the earliest index `i` such that keeping `messages.slice(i)` is
 * structurally valid — i.e. no `role:'tool'` message in the kept window is
 * orphaned from its declaring `assistant(tool_calls)` turn.
 *
 * Concretely: if the naive cut would land right after an assistant message
 * that has `toolCalls`, push the cut backward to BEFORE that assistant (so
 * the whole call→result chain survives). We also scan forward from the cut
 * to cover any tool results whose declaring assistant sits just before the
 * cut (defensive — the provider loop always appends results right after, but
 * the invariant is what matters, not the append order assumption).
 */
function findValidCutIndex(messages: readonly AgentMessage[], naiveCut: number): number {
  let cut = naiveCut;
  // Walk backward while the message at `cut` is a tool result whose caller
  // would be dropped. Collect the tool_call_ids the kept window starts with.
  while (cut < messages.length) {
    const kept = messages.slice(cut);
    // tool_call_ids declared by assistant messages INSIDE the kept window.
    const declared = new Set<string>();
    for (const m of kept) {
      if (m.role === "assistant" && m.toolCalls) {
        for (const tc of m.toolCalls) declared.add(tc.id);
      }
    }
    // Does the first kept message (or any early tool) lack a declarer?
    // Check only tool messages whose toolCallId is NOT in `declared` and
    // whose declarer would be in the dropped prefix.
    let moved = false;
    for (let k = 0; k < kept.length; k++) {
      const m = kept[k];
      if (m.role === "tool" && m.toolCallId && !declared.has(m.toolCallId)) {
        // This tool result's caller is in the dropped prefix → extend cut
        // backward to include the caller. Walk left from `cut` to find the
        // assistant that declared this toolCallId.
        for (let j = cut - 1; j >= 0; j--) {
          const prev = messages[j];
          if (
            prev.role === "assistant" &&
            prev.toolCalls &&
            prev.toolCalls.some((tc) => tc.id === m.toolCallId)
          ) {
            cut = j;
            moved = true;
            break;
          }
        }
        break; // re-evaluate from the new cut
      }
    }
    if (!moved) break;
  }
  return cut;
}

/**
 * Tool-result prune limits + result metadata (cache-aware compaction).
 */

export interface ToolResultPruneOptions {
  /** Max chars retained for a single tool result body (head + tail). Default 8000 (ZELARI_TOOL_RESULT_MAX_CHARS). */
  maxChars?: number;
  /** Chars preserved from the tail (errors / final output usually live at the end). Default 1000 (ZELARI_TOOL_RESULT_TAIL_CHARS). */
  tailChars?: number;
}

export interface ToolResultPruneStats {
  /** Number of tool messages whose content was truncated. */
  pruned: number;
  /** Total chars omitted across all pruned tool messages. */
  charsOmitted: number;
}

function resolvePruneLimits(opts?: ToolResultPruneOptions): {
  maxChars: number;
  tailChars: number;
} {
  const maxChars =
    opts?.maxChars ??
    envNumber(process.env.ZELARI_TOOL_RESULT_MAX_CHARS, { default: 8000, min: 256 });
  const rawTail =
    opts?.tailChars ??
    envNumber(process.env.ZELARI_TOOL_RESULT_TAIL_CHARS, { default: 1000, min: 0 });
  // Never keep more tail than the whole budget (avoids headChars < 0).
  const tailChars = Math.min(rawTail, maxChars);
  return { maxChars, tailChars };
}

/**
 * Truncate oversized `role:'tool'` result bodies in-place (head + tail),
 * preserving message order and `toolCallId`. This shrinks the token
 * footprint WITHOUT dropping messages, so the append-only server-side
 * prefix cache (DeepSeek/GLM/Qwen) keeps hitting across the tool loop.
 * Returns the SAME array reference when nothing changed (cheap compare).
 *
 * @since v1.35.x — cache-aware compaction (dsh compaction-tool-result-pruner).
 */
export function pruneToolResults(
  messages: readonly AgentMessage[],
  opts?: ToolResultPruneOptions,
): AgentMessage[] {
  return pruneToolResultsDetailed(messages, opts).messages;
}

export function pruneToolResultsDetailed(
  messages: readonly AgentMessage[],
  opts?: ToolResultPruneOptions,
): { messages: AgentMessage[]; stats: ToolResultPruneStats } {
  const { maxChars, tailChars } = resolvePruneLimits(opts);
  const headChars = maxChars - tailChars;
  const stats: ToolResultPruneStats = { pruned: 0, charsOmitted: 0 };
  let changed = false;
  const out = messages.map((m) => {
    if (m.role !== "tool") return m;
    const body = m.content ?? "";
    if (body.length <= maxChars) return m;
    const head = headChars > 0 ? body.slice(0, headChars) : "";
    const tail = tailChars > 0 ? body.slice(-tailChars) : "";
    const omitted = body.length - head.length - tail.length;
    changed = true;
    stats.pruned += 1;
    stats.charsOmitted += omitted;
    return {
      ...m,
      content: [head, "…[pruned " + omitted + " chars]…", tail].join(String.fromCharCode(10)),
    };
  });
  return {
    messages: changed ? out : (messages as AgentMessage[]),
    stats,
  };
}

/**
 * Compact a rolling-history `AgentMessage[]` when it exceeds the cap.
 *
 * Returns the SAME array reference (unmutated) when no compaction is needed,
 * so callers can compare by reference cheaply on the hot path.
 *
 * Uses extractive summary of dropped turns (sync, no network).
 */
export function compactHistory(
  messages: readonly AgentMessage[],
  opts?: CompactHistoryOptions,
): AgentMessage[] {
  return compactHistoryDetailed(messages, opts).messages;
}

/**
 * v1.36.0 (P12): the compaction checkpoint is a USER message, not a new
 * system policy block. The system prompt stays stable (1–2 messages, byte
 * identical across turns) so the provider prefix cache keeps hitting; the
 * checkpoint replaces the dropped conversation as model-visible user
 * context. This is the same surface pattern used by DSH-style harnesses.
 */
const CHECKPOINT_WRAPPER_PREFIX =
  'This is an automatically generated checkpoint of earlier conversation. ' +
  'Treat it as established context and continue directly.';

export function buildCheckpointMessage(
  summaryText: string,
  range?: { fromSeq: number; toSeq: number; sourceEventSeqs: number[] },
): AgentMessage {
  return {
    role: 'user',
    content:
      CHECKPOINT_WRAPPER_PREFIX +
      '\n\n<compacted-summary>\n' +
      summaryText +
      '\n</compacted-summary>',
    ...(range
      ? {
          compactedFromSeq: range.fromSeq,
          compactedToSeq: range.toSeq,
          sourceEventSeqs: [...range.sourceEventSeqs],
        }
      : {}),
  };
}

/**
 * Same as compactHistory but returns metadata (removed count + summary text).
 */
export function compactHistoryDetailed(
  messages: readonly AgentMessage[],
  opts?: CompactHistoryOptions,
): CompactHistoryResult {
  const maxMessages = resolveMaxMessages(opts);
  if (maxMessages === 0) {
    return withDroppedRange(
      { messages: [], compacted: true, messagesRemoved: messages.length, summary: '' },
      messages,
      'extractive',
    );
  }
  // v2.32.0 (S3): the PRIMARY trigger is the adaptive character budget —
  // history compacts when its CONTENT weight exceeds the budget, not when a
  // turn count says so. The legacy count trigger (2 × cap) only applies when
  // the user made the count an explicit contract (ZELARI_HISTORY_TURNS set,
  // or maxMessages passed). v1.36.0 (P8): occupancy-driven callers pass
  // force=true so high TOKEN pressure compacts regardless.
  const charBudget = resolveHistoryCharBudget(opts);
  const explicitCount =
    opts?.maxMessages !== undefined || process.env.ZELARI_HISTORY_TURNS !== undefined;
  const overChars = historyChars(messages) > charBudget;
  const overCount = messages.length > maxMessages * 2;
  const shouldCompact = overChars || (explicitCount && overCount) || !!opts?.force;
  if (!shouldCompact) {
    return {
      messages: messages as AgentMessage[],
      compacted: false,
      messagesRemoved: 0,
      summary: "",
    };
  }

  // Cut target: keep the newest tail that fits the char budget AND the
  // count cap (whichever binds). Oldest-first, then tool-chain atomicity.
  let naiveCut: number;
  if (overChars) {
    let cut = 0;
    let keptChars = historyChars(messages);
    while (cut < messages.length && keptChars > charBudget) {
      keptChars -= (messages[cut].content ?? '').length;
      cut += 1;
    }
    // Never keep MORE than the count cap allows (runaway net).
    naiveCut = Math.max(cut, messages.length - maxMessages);
  } else {
    naiveCut = Math.max(0, messages.length - maxMessages);
  }
  const cut = findValidCutIndex(messages, naiveCut);
  if (cut === 0) {
    return {
      messages: messages as AgentMessage[],
      compacted: false,
      messagesRemoved: 0,
      summary: "",
    };
  }

  const droppedMsgs = messages.slice(0, cut);
  const droppedRange = compactedRangeFromDropped(droppedMsgs);
  const pruned = pruneToolResultsDetailed(messages.slice(cut));
  const kept = pruned.messages;
  const summaryText = extractiveHistorySummary(droppedMsgs);
  const summary = buildCheckpointMessage(
    summaryText || `${COMPACT_MARKER} ${cut} earlier message(s) dropped.`,
    droppedRange,
  );
  return withDroppedRange(
    {
      messages: [summary, ...kept],
      compacted: true,
      messagesRemoved: cut,
      summary: summary.content,
      prunedToolResults: pruned.stats.pruned,
    },
    droppedMsgs,
    'extractive',
  );
}

/**
 * Async compaction: extractive summary, then optional LLM rewrite when
 * ZELARI_LLM_COMPACT is enabled (default). Falls back to extractive on any error.
 */
export async function compactHistoryAsync(
  messages: readonly AgentMessage[],
  opts?: CompactHistoryOptions & {
    signal?: AbortSignal;
    /**
     * v1.36.0 (P10): last routed request snapshot — the replay base. When
     * present (with providerStream) the summarizer replays the ORIGINAL
     * system prefix + tool schemas + dropped prefix and appends the
     * compaction instruction, so the provider prefix cache keeps hitting.
     */
    requestSnapshot?: {
      provider: string;
      model: string;
      systemMessages: readonly AgentMessage[];
      tools: readonly AgentToolSpec[];
    } | null;
    providerStream?: import('@zelari/core/harness').ProviderStreamFn;
  },
): Promise<CompactHistoryResult> {
  const base = compactHistoryDetailed(messages, opts);
  if (!base.compacted || base.messagesRemoved === 0) return base;

  const cut = base.messagesRemoved;
  const droppedMsgs = messages.slice(0, cut);
  const extractive = extractiveHistorySummary(droppedMsgs);

  let summaryText = extractive;
  let cacheReuseExpected: boolean | undefined;
  let replayExactPrefix: boolean | undefined;

  const canReplay = !!(opts?.providerStream && opts?.requestSnapshot);

  if (canReplay) {
    try {
      const replay = await llmSummarizeHistoryReplay({
        providerStream: opts!.providerStream!,
        provider: opts!.requestSnapshot!.provider,
        model: opts!.requestSnapshot!.model,
        systemMessages: opts!.requestSnapshot!.systemMessages,
        tools: opts!.requestSnapshot!.tools as import('@zelari/core/harness').AgentToolSpec[],
        droppedMessages: droppedMsgs,
        signal: opts?.signal,
      });
      cacheReuseExpected = replay.cacheReuseExpected;
      if (replay.summary && replay.summary.trim().length > 40) {
        // P13: a summary that does not shrink the source is a failed
        // compaction — keep the (much smaller) extractive sketch instead.
        const sourceTokens = roughTokens(droppedMsgs);
        const summaryTok = Math.ceil(replay.summary.length / 4);
        if (summaryTok < sourceTokens) {
          summaryText = replay.summary.trim();
        }
      }
    } catch {
      // keep extractive
    }
  }

  const pruned = pruneToolResultsDetailed(messages.slice(cut));
  const kept = pruned.messages;
  const summary = buildCheckpointMessage(summaryText, compactedRangeFromDropped(droppedMsgs));
  const usedLlm = summaryText !== extractive && summaryText.trim().length > 40;
  return withDroppedRange(
    {
      messages: [summary, ...kept],
      compacted: true,
      messagesRemoved: cut,
      summary: summaryText,
      prunedToolResults: pruned.stats.pruned,
      cacheReuseExpected,
      replayExactPrefix,
    },
    droppedMsgs,
    usedLlm ? 'llm' : 'extractive',
  );
}

/** Rough chars/4 token estimate over content + tool args (local, no cycle). */
function roughTokens(msgs: readonly AgentMessage[]): number {
  let n = 0;
  for (const m of msgs) {
    n += Math.ceil((m.content ?? '').length / 4);
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        n += Math.ceil(JSON.stringify(tc.args ?? {}).length / 4);
      }
    }
  }
  return Math.max(1, n);
}
