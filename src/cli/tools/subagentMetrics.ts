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
  /** Tool executions that ended in error (uncapped, subset of `toolCalls`). */
  toolErrors?: number;
}

/** Minimum failed tool executions before a run can be called degraded. */
export const TOOL_DEGRADED_MIN_ERRORS = 2;

/**
 * Tool-channel degradation (F4, 2026-09-24 muse incident): a tentacle whose
 * tools mostly FAILED still ends `ok:true` (it produced a report), and the
 * radio used to record it as a clean success. Degraded = at least
 * {@link TOOL_DEGRADED_MIN_ERRORS} failures AND at least half of all tool
 * executions failed. Pure counts — never text heuristics on the report.
 */
export function isToolChannelDegraded(toolCalls?: number, toolErrors?: number): boolean {
  if (typeof toolCalls !== 'number' || typeof toolErrors !== 'number') return false;
  return toolErrors >= TOOL_DEGRADED_MIN_ERRORS && toolErrors * 2 >= toolCalls;
}

/**
 * Parent-facing guard line for a degraded run (WITHOUT leading newline):
 * the report was produced on a broken tool channel, so its findings must not
 * be trusted as observed evidence.
 */
export function formatToolDegradedGuardLine(toolCalls: number, toolErrors: number): string {
  return (
    `tools degraded: ${toolErrors}/${toolCalls} tool calls failed in this tentacle — ` +
    'treat its findings as UNVERIFIED and re-check key facts before acting on them.'
  );
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
  if (typeof input.toolCalls === 'number') {
    tail.push(
      typeof input.toolErrors === 'number' && input.toolErrors > 0
        ? `${input.toolCalls} tool calls (${input.toolErrors} failed)`
        : `${input.toolCalls} tool calls`,
    );
  }
  if (typeof input.turns === 'number') tail.push(`${input.turns} turns`);
  const head = `metrics: ${tokens} tokens`;
  return tail.length > 0 ? `${head} · ${tail.join(' · ')}` : head;
}
