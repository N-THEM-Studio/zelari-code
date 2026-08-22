/**
 * tools/eval/cost.ts — unified cost metric primitives (2.6 Track B, doc §15).
 *
 * North star: cost per VERIFIED solved task. Quality/cost/latency move
 * together: a solve-rate increase never implies automatic promotion.
 * Aggregations + pareto report live here too (F9).
 */

export interface RunCost {
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  toolCalls: number;
  modelCostUsd: number;
  toolCostUsd?: number;
  wallMs: number;
}

export function zeroCost(): RunCost {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheHitTokens: 0,
    toolCalls: 0,
    modelCostUsd: 0,
    wallMs: 0,
  };
}

/** Component-wise sum (toolCostUsd stays undefined unless any input has it). */
export function addCost(...costs: RunCost[]): RunCost {
  return costs.reduce<RunCost>(
    (acc, c) => ({
      inputTokens: acc.inputTokens + c.inputTokens,
      outputTokens: acc.outputTokens + c.outputTokens,
      cacheHitTokens: acc.cacheHitTokens + c.cacheHitTokens,
      toolCalls: acc.toolCalls + c.toolCalls,
      modelCostUsd: round6(acc.modelCostUsd + c.modelCostUsd),
      toolCostUsd:
        acc.toolCostUsd === undefined && c.toolCostUsd === undefined
          ? undefined
          : round6((acc.toolCostUsd ?? 0) + (c.toolCostUsd ?? 0)),
      wallMs: acc.wallMs + c.wallMs,
    }),
    zeroCost(),
  );
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
