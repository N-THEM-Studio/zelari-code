/**
 * contextGrowth — per-run context-growth accounting (2026-07 plan, Fase M).
 *
 * Measures what the "context-growth avoidance" thesis cares about:
 *  - how many tool round-trips a run needed,
 *  - how many bytes of tool results entered the model-facing history,
 *  - how large the serialized message array was at each LLM request,
 *  - how much of the prompt the provider prefix cache absorbed.
 *
 * The harness mutates one ContextGrowthStats per run() and snapshots it into
 * a log-only `context_metrics` BrainEvent right before `agent_end` — it never
 * reaches the model-facing history.
 *
 * Pure UTF-8 byte math via TextEncoder (no Node-only imports: this module
 * stays renderer-safe like the event contract it feeds).
 */

import type { UsageBreakdown } from '../shared/events.js';

/** Mutable per-run counters. Create via {@link emptyContextGrowthStats}. */
export interface ContextGrowthStats {
  /** Tool executions completed (one per tool_execution_end). */
  toolRoundTrips: number;
  /** UTF-8 bytes of tool-result strings appended to model history. */
  intermediateToolBytes: number;
  /** LLM requests issued this run (>= 1; grows with the tool loop). */
  requests: number;
  /** UTF-8 bytes of the serialized messages array at the LAST request. */
  historyBytesLast: number;
  /** Max historyBytesLast seen this run. */
  historyBytesPeak: number;
  /** Prompt tokens served from the provider prefix cache this run. */
  cacheHitTokens: number;
}

export function emptyContextGrowthStats(): ContextGrowthStats {
  return {
    toolRoundTrips: 0,
    intermediateToolBytes: 0,
    requests: 0,
    historyBytesLast: 0,
    historyBytesPeak: 0,
    cacheHitTokens: 0,
  };
}

const encoder = new TextEncoder();

/** UTF-8 byte length of a string (TextEncoder — renderer-safe). */
export function utf8Bytes(s: string): number {
  return encoder.encode(s).length;
}

/** UTF-8 byte length of the JSON serialization of a value (0 on failure). */
export function jsonBytes(value: unknown): number {
  try {
    return utf8Bytes(JSON.stringify(value));
  } catch {
    return 0;
  }
}

/**
 * Fold one completed tool execution. `content` must be the EXACT string that
 * is appended to the model-facing history (same string carried by the
 * `tool_execution_end` event) so the metric equals ground truth, not an
 * approximation of it.
 */
export function recordToolResult(s: ContextGrowthStats, content: string): void {
  s.toolRoundTrips += 1;
  s.intermediateToolBytes += utf8Bytes(content);
}

/**
 * Fold one LLM request. `messages` is the exact array handed to the provider
 * stream — the serialized size of that array is the request surface the
 * prefix cache sees.
 */
export function recordRequest(s: ContextGrowthStats, messages: unknown[]): void {
  s.requests += 1;
  s.historyBytesLast = jsonBytes(messages);
  if (s.historyBytesLast > s.historyBytesPeak) s.historyBytesPeak = s.historyBytesLast;
}

/** Fold provider-reported usage (cache-hit tokens only, null-safe). */
export function recordUsage(
  s: ContextGrowthStats,
  usage: UsageBreakdown | null | undefined,
): void {
  const cached = usage?.cachedPromptTokens ?? 0;
  if (cached > 0) s.cacheHitTokens += cached;
}
