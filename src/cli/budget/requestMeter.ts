/**
 * requestMeter — full-request occupancy estimation with provider-usage
 * anchoring (v1.36.0 context/cache upgrade; P4/P5).
 *
 * The legacy `estimateHistoryTokens` measured ONLY the rolling history
 * (`content` + `toolCalls` args). It ignored the system prompt, tool
 * schemas, `reasoningContent`, and per-message role overhead — tens of
 * thousands of tokens in tool-heavy sessions — so occupancy read low and
 * compaction fired too late (or never).
 *
 * This meter measures the WHOLE request surface:
 *
 *   estimatedPromptTokens ≈ system + tools-schema + conversation
 *
 * and anchors to provider-reported usage when the header fingerprint
 * matches the last routed request: provider usage is ground truth for
 * the stable header, so we only re-estimate the conversation DELTA.
 *
 * `contextPressureTokens` NEVER subtracts cached tokens: the provider
 * must still HOLD the whole prefix (cached or not) in the context window.
 *
 * @since v1.36.0
 */

import type { AgentMessage, AgentToolSpec, RoutedRequestSnapshot } from '@zelari/core/harness';
import {
  stableStringify,
  sha256Hex,
  canonicalTools,
} from '@zelari/core/harness';
import type { StoredRequestUsage } from './requestSnapshotStore.js';

/** Local chars→tokens estimate (same heuristic as tokenBudget; local copy to
 *  avoid a tokenBudget ⇄ requestMeter import cycle). */
function estimateTokensLocal(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** ~4 tokens of wire overhead per message (role/id framing). */
const MESSAGE_OVERHEAD_TOKENS = 4;

export interface RequestMeterInput {
  systemMessages: readonly AgentMessage[];
  tools: readonly AgentToolSpec[];
  conversation: readonly AgentMessage[];
  /**
   * Last routed snapshot + its provider-reported usage. When the header
   * fingerprint matches, the meter uses `usage.promptTokens` as the anchor
   * for the stable surface instead of the chars/4 estimate.
   */
  anchor?: {
    snapshot: RoutedRequestSnapshot;
    usage?: StoredRequestUsage;
  } | null;
}

export interface RequestMeterResult {
  /** Estimated prompt tokens for the FULL request (header + conversation). */
  estimatedPromptTokens: number;
  /** Tokens of the stable header (system + tools), estimated. */
  estimatedHeaderTokens: number;
  /** True when provider usage anchored the header measurement. */
  headerAnchored: boolean;
  /**
   * Tokens the provider must hold = estimatedPromptTokens + reserved output.
   * Cached prompt tokens are NOT subtracted (they still occupy the window).
   */
  contextPressureTokens: number;
  occupancy: number;
  purpose: 'conversation' | 'compaction';
}

/** Estimate one message across ALL its token-bearing fields. */
export function estimateMessageTokens(m: AgentMessage): number {
  let n = MESSAGE_OVERHEAD_TOKENS + estimateTokensLocal(m.content ?? '');
  if (m.toolCalls) {
    for (const tc of m.toolCalls) {
      n += estimateTokensLocal(tc.name) + estimateTokensLocal(tc.id);
      n += estimateTokensLocal(JSON.stringify(tc.args ?? {}));
    }
  }
  if (m.reasoningContent) n += estimateTokensLocal(m.reasoningContent);
  if (m.toolCallId) n += estimateTokensLocal(m.toolCallId);
  return n;
}

/** Estimate the tool-schema surface (name + description + parameters). */
export function estimateToolSchemaTokens(tools: readonly AgentToolSpec[]): number {
  let n = 0;
  for (const t of tools) {
    n += estimateTokensLocal(t.name) + estimateTokensLocal(t.description ?? '');
    n += estimateTokensLocal(JSON.stringify(t.parameters ?? {}));
  }
  // Wire framing per advertised function.
  return n + tools.length * MESSAGE_OVERHEAD_TOKENS;
}

/** Estimate the system-prompt surface. */
export function estimateSystemTokens(
  systemMessages: readonly AgentMessage[],
): number {
  let n = 0;
  for (const m of systemMessages) n += estimateMessageTokens(m);
  return n;
}

/** Estimated tokens of the conversation tail. */
export function estimateConversationTokens(
  conversation: readonly AgentMessage[],
): number {
  let n = 0;
  for (const m of conversation) n += estimateMessageTokens(m);
  return n;
}

/**
 * Same fingerprint discipline as requestSnapshot: provider + model + system
 * + canonical tools. Cheap enough to recompute per turn.
 */
export function headerFingerprintOf(input: {
  provider: string;
  model: string;
  systemMessages: readonly AgentMessage[];
  tools: readonly AgentToolSpec[];
}): string {
  return createFingerprintOnly(input);
}

function createFingerprintOnly(input: {
  provider: string;
  model: string;
  systemMessages: readonly AgentMessage[];
  tools: readonly AgentToolSpec[];
}): string {
  return sha256Hex(
    stableStringify({
      provider: input.provider,
      model: input.model,
      systemMessages: input.systemMessages,
      tools: canonicalTools(input.tools),
    }),
  );
}

/**
 * Measure the full request surface.
 *
 * Anchoring: when `anchor.snapshot`'s headerFingerprint equals the current
 * header fingerprint AND its usage arrived, the stable header is measured
 * as `usage.promptTokens - estimatedConversationTokens(anchor.conversation)`
 * (clamped to ≥0) — provider ground truth beats chars/4. The current
 * conversation is always freshly estimated.
 */
export function measureRequest(
  input: RequestMeterInput & {
    contextLimit: number;
    reservedOutputTokens?: number;
    purpose?: 'conversation' | 'compaction';
  },
): RequestMeterResult {
  const estimatedHeaderTokens =
    estimateSystemTokens(input.systemMessages) + estimateToolSchemaTokens(input.tools);
  const currentConversationTokens = estimateConversationTokens(input.conversation);

  let headerAnchored = false;
  let headerTokens = estimatedHeaderTokens;

  const anchorUsage = input.anchor?.usage;
  const anchorSnapshot = input.anchor?.snapshot;
  if (anchorUsage && anchorSnapshot) {
    const currentHeaderFp = createFingerprintOnly({
      provider: anchorSnapshot.provider,
      model: anchorSnapshot.model,
      systemMessages: input.systemMessages,
      tools: input.tools,
    });
    if (currentHeaderFp === anchorSnapshot.headerFingerprint) {
      // Provider saw header + its conversation; subtract the conversation
      // estimate to isolate the header ground truth.
      const anchorConv = estimateConversationTokens(anchorSnapshot.conversation);
      const headerFromUsage = Math.max(0, anchorUsage.promptTokens - anchorConv);
      // v1.36.0 (case 9): the provider truth is EXPECTED to dwarf the
      // chars/4 estimate (chat templating, tool marshalling, hidden
      // framing). Anchoring exists precisely for that gap — so only a
      // non-positive (garbage/empty) value is rejected, never a large one.
      if (headerFromUsage > 0) {
        headerTokens = headerFromUsage;
        headerAnchored = true;
      }
    }
  }

  const estimatedPromptTokens = headerTokens + currentConversationTokens;
  const reservedOutput = input.reservedOutputTokens ?? 0;
  const contextPressureTokens = estimatedPromptTokens + reservedOutput;

  return {
    estimatedPromptTokens,
    estimatedHeaderTokens,
    headerAnchored,
    contextPressureTokens,
    occupancy: Math.min(1, contextPressureTokens / input.contextLimit),
    purpose: input.purpose ?? 'conversation',
  };
}
