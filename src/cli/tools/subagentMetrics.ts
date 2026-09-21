/**
 * subagentMetrics — honest one-line usage footer for tentacle results
 * (t156 · 2026-09-21 tentacle plan P2a-1).
 *
 * The sub-agent loop already measures provider-reported usage (summed
 * across turns) and counts tool executions; until now those numbers had
 * NO consumer — measured and thrown away. This module formats them into
 * the parent-facing result footer. It is the prerequisite for the K5.3
 * data-gated flips: without a consumer those numbers do not exist.
 *
 * Honesty rules (load-bearing):
 *   - No usage reported by the provider ⇒ EMPTY string. Never fabricate
 *     zeros or approximations.
 *   - `cached` appears only when the provider actually reported >0 cached
 *     prompt tokens.
 *   - `toolCalls` is the TOTAL count of tool executions observed by the
 *     loop — NOT `toolTrace.length`, which is ring-capped at 24 entries
 *     and would silently lie about long runs.
 */

export interface SubagentMetricsInput {
  /** Provider-reported token usage (prompt/completion/cached/total). */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedPromptTokens?: number;
  };
  /** Total tool executions observed in the sub-agent loop (uncapped). */
  toolCalls?: number;
  /** Completed assistant messages in the sub-agent loop. */
  turns?: number;
}

/**
 * Format the metrics footer line (WITHOUT leading newline).
 * Returns '' when there is nothing honest to report (no usage).
 */
export function formatSubagentMetricsLine(input: SubagentMetricsInput): string {
  const { usage } = input;
  if (!usage) return '';
  const tokens = [
    `${usage.promptTokens} prompt`,
    `${usage.completionTokens} completion`,
    ...(usage.cachedPromptTokens && usage.cachedPromptTokens > 0
      ? [`${usage.cachedPromptTokens} cached`]
      : []),
    `${usage.totalTokens} total`,
  ].join(' / ');
  const tail: string[] = [];
  if (typeof input.toolCalls === 'number') tail.push(`${input.toolCalls} tool calls`);
  if (typeof input.turns === 'number') tail.push(`${input.turns} turns`);
  const head = `metrics: ${tokens} tokens`;
  return tail.length > 0 ? `${head} · ${tail.join(' · ')}` : head;
}
