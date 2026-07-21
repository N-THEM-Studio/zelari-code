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

import type { AgentMessage } from "@zelari/core/harness";
import {
  extractiveHistorySummary,
  formatDroppedForLlm,
} from "../budget/historySummary.js";
import { llmSummarizeHistory } from "../budget/llmCompact.js";
import { envNumber } from "../utils/envNumber.js";

export interface CompactHistoryOptions {
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
}

/**
 * Resolve the effective max-messages cap from options or the env var.
 * Returns 0 to signal "history disabled" (caller should short-circuit).
 */
export function resolveMaxMessages(opts?: CompactHistoryOptions): number {
  // v1.7.0: routed through envNumber. Behavior preserved (default 6, min 0
  // because ZELARI_HISTORY_TURNS=0 legitimately means "disable history" —
  // the pre-1.6 stateless fallback — and must NOT be coerced to a non-zero
  // default on a typo).
  const envTurns = envNumber(process.env.ZELARI_HISTORY_TURNS, { default: 6, min: 0 });
  // opts override env; env default is 6 turns × ~4 messages/turn.
  let turns = opts?.maxMessages ? Math.ceil(opts.maxMessages / 4) : envTurns;
  // With durable state, default to a tighter window (min 2 turns) unless the
  // user explicitly set maxMessages or a non-default HISTORY_TURNS.
  if (
    opts?.durableStatePresent &&
    !opts?.maxMessages &&
    process.env.ZELARI_HISTORY_TURNS === undefined
  ) {
    turns = Math.min(turns, 3);
  }
  if (turns <= 0) return 0;
  return turns * 4;
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
 * Same as compactHistory but returns metadata (removed count + summary text).
 */
export function compactHistoryDetailed(
  messages: readonly AgentMessage[],
  opts?: CompactHistoryOptions,
): CompactHistoryResult {
  const maxMessages = resolveMaxMessages(opts);
  if (maxMessages === 0) {
    return { messages: [], compacted: true, messagesRemoved: messages.length, summary: "" };
  }
  // Trigger at 2× cap so we don't compact on every single turn (amortize).
  if (messages.length <= maxMessages * 2) {
    return {
      messages: messages as AgentMessage[],
      compacted: false,
      messagesRemoved: 0,
      summary: "",
    };
  }

  const naiveCut = messages.length - maxMessages;
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
  const kept = messages.slice(cut);
  const summaryText = extractiveHistorySummary(droppedMsgs);
  const summary: AgentMessage = {
    role: "system",
    content: summaryText || `${COMPACT_MARKER} ${cut} earlier message(s) dropped.`,
  };
  return {
    messages: [summary, ...kept],
    compacted: true,
    messagesRemoved: cut,
    summary: summary.content,
  };
}

/**
 * Async compaction: extractive summary, then optional LLM rewrite when
 * ZELARI_LLM_COMPACT is enabled (default). Falls back to extractive on any error.
 */
export async function compactHistoryAsync(
  messages: readonly AgentMessage[],
  opts?: CompactHistoryOptions & { signal?: AbortSignal },
): Promise<CompactHistoryResult> {
  const base = compactHistoryDetailed(messages, opts);
  if (!base.compacted || base.messagesRemoved === 0) return base;

  const cut = base.messagesRemoved;
  const droppedMsgs = messages.slice(0, cut);
  const extractive = extractiveHistorySummary(droppedMsgs);
  const droppedTranscript = formatDroppedForLlm(droppedMsgs);

  let summaryText = extractive;
  try {
    const llm = await llmSummarizeHistory({
      extractive,
      droppedTranscript,
      signal: opts?.signal,
    });
    if (llm && llm.trim().length > 40) summaryText = llm.trim();
  } catch {
    // keep extractive
  }

  const kept = messages.slice(cut);
  const summary: AgentMessage = { role: "system", content: summaryText };
  return {
    messages: [summary, ...kept],
    compacted: true,
    messagesRemoved: cut,
    summary: summaryText,
  };
}
