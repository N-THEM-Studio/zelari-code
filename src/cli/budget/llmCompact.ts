/**
 * LLM compaction via CACHE-AWARE PREFIX REPLAY (v1.36.0, P9).
 *
 * Pre-1.36 this module built a COLD request: its own COMPACT_SYSTEM, a
 * flattened transcript, and a raw fetch to the chat-completions endpoint.
 * That request diverged from the live conversation from token 0 — zero
 * prompt-cache reuse — and the rewritten history invalidated the warm
 * prefix for the NEXT conversation turn too.
 *
 * The replay approach sends:
 *
 *   SYSTEM(original) + TOOLS(original) + DROPPED PREFIX + COMPACTION_INSTRUCTION
 *
 * so everything up to the trailing instruction is byte-identical to the
 * previous routed request and hits the provider prefix cache (DeepSeek/
 * OpenAI/GLM bill cached tokens at ~1/10). Tools stay advertised even
 * though the summarizer must not call them: removing them would change
 * the prefix token sequence and kill cache reuse.
 *
 * Fallback: any failure → null → caller uses the extractive summary.
 * Disable entirely with ZELARI_LLM_COMPACT=0.
 *
 * @since v1.21.0 (cold-request version)
 * @updated v1.36.0 — replay-based, providerStream-routed
 */

import type {
  AgentMessage,
  AgentToolSpec,
  ProviderStreamFn,
} from '@zelari/core/harness';

export const COMPACTION_INSTRUCTION = `
You are now acting as a compaction engine for this coding-agent session.

Condense the conversation ABOVE into a compact checkpoint sufficient to continue the task.

Preserve:
- user's goal and evolving intent
- decisions already made
- exact file paths and identifiers
- code changes already completed
- commands/errors that still matter
- constraints
- unfinished work
- the single most likely next action

Do not call tools.
Do not mention this summarization request.
Output only the checkpoint.
Be concise.
`.trim();

export function isLlmCompactEnabled(): boolean {
  const v = process.env.ZELARI_LLM_COMPACT?.trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  // default on when env unset
  return true;
}

/** Explicit model override for the summarizer (ZELARI_COMPACT_MODEL). */
export function compactModelOverride(): string | undefined {
  const v = process.env.ZELARI_COMPACT_MODEL?.trim();
  return v ? v : undefined;
}

export interface LlmSummarizeReplayInput {
  /** Provider stream of the ACTIVE conversation (failover-wrapped is fine). */
  providerStream: ProviderStreamFn;
  provider: string;
  model: string;
  /** Original system prefix of the request being compacted. */
  systemMessages: readonly AgentMessage[];
  /** Original tool schemas (kept for prefix stability — must not be called). */
  tools: readonly AgentToolSpec[];
  /** The message prefix that is about to be dropped. */
  droppedMessages: readonly AgentMessage[];
  signal?: AbortSignal;
  /** When set (ZELARI_COMPACT_MODEL), replay runs on another model → no KV reuse. */
  overrideModel?: string;
}

export interface LlmSummarizeReplayResult {
  summary: string | null;
  /** Model actually used. */
  model: string;
  /**
   * False when an override model forced a different sequence — the replay
   * still works, but the provider cache cannot be reused (documented
   * trade-off, DSH-style).
   */
  cacheReuseExpected: boolean;
}

/** Hard ceiling so a stuck summarizer can't hang the dispatch loop. */
const REPLAY_TIMEOUT_MS = 60_000;

/**
 * Summarize `droppedMessages` by replaying the ORIGINAL request prefix and
 * appending the compaction instruction as the final user message.
 *
 * Returns `summary: null` when disabled, empty, failed, or when the model
 * emitted a tool call (the summarizer must never act — only condense).
 */
export async function llmSummarizeHistoryReplay(
  input: LlmSummarizeReplayInput,
): Promise<LlmSummarizeReplayResult> {
  const override = input.overrideModel ?? compactModelOverride();
  const model = override ?? input.model;
  const cacheReuseExpected = !override;

  if (!isLlmCompactEnabled()) return { summary: null, model, cacheReuseExpected };
  if (input.droppedMessages.length === 0) {
    return { summary: null, model, cacheReuseExpected };
  }

  // Replay = original prefix + instruction tail. The prefix must be
  // byte-identical to the previous routed request for cache reuse.
  const messages: AgentMessage[] = [
    ...input.systemMessages,
    ...input.droppedMessages,
    {
      role: 'user',
      content: COMPACTION_INSTRUCTION,
    },
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REPLAY_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  input.signal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    let text = '';
    let emittedToolCall = false;

    for await (const delta of input.providerStream({
      provider: input.provider,
      model,
      messages,
      // Tools stay advertised: dropping them would change the prefix token
      // sequence and destroy cache reuse (explicit DSH decision). They are
      // sorted canonically (same discipline as the live routed request and
      // the snapshot fingerprints) so the replay prefix is byte-identical.
      tools: [...input.tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      signal: controller.signal,
      generation: {
        purpose: 'compaction',
        temperature: 0.1,
        maxTokens: 900,
      },
    })) {
      if (delta.kind === 'text') text += delta.delta;
      if (delta.kind === 'tool_call') emittedToolCall = true;
    }

    if (emittedToolCall) return { summary: null, model, cacheReuseExpected };
    if (!text.trim()) return { summary: null, model, cacheReuseExpected };

    return { summary: text.trim(), model, cacheReuseExpected };
  } catch {
    return { summary: null, model, cacheReuseExpected };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', onOuterAbort);
  }
}
