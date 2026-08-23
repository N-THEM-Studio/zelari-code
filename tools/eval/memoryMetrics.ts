/** Deterministic quality/latency metrics for repeatable project-memory gates. */
export interface MemoryEvalCase {
  id: string;
  relevantIds: string[];
  forbiddenIds?: string[];
}

export interface MemoryEvalObservation {
  caseId: string;
  returnedIds: string[];
  contextTokens: number;
  latencyMs: number;
}

export interface MemoryEvalMetrics {
  cases: number;
  recallAtK: number;
  precisionAtK: number;
  staleInjectionRate: number;
  duplicateRate: number;
  usefulMemoriesPer1kTokens: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

export function evaluateMemoryRecall(
  cases: readonly MemoryEvalCase[],
  observations: readonly MemoryEvalObservation[],
): MemoryEvalMetrics {
  const byCase = new Map(observations.map((observation) => [observation.caseId, observation]));
  let recall = 0;
  let precision = 0;
  let stale = 0;
  let duplicates = 0;
  let returned = 0;
  let useful = 0;
  let tokens = 0;
  const latencies: number[] = [];
  for (const scenario of cases) {
    const observation = byCase.get(scenario.id) ?? {
      caseId: scenario.id, returnedIds: [], contextTokens: 0, latencyMs: 0,
    };
    const relevant = new Set(scenario.relevantIds);
    const forbidden = new Set(scenario.forbiddenIds ?? []);
    const unique = new Set(observation.returnedIds);
    const hits = [...unique].filter((memoryId) => relevant.has(memoryId)).length;
    recall += relevant.size === 0 ? (observation.returnedIds.length === 0 ? 1 : 0) : hits / relevant.size;
    precision += observation.returnedIds.length === 0
      ? (relevant.size === 0 ? 1 : 0)
      : hits / observation.returnedIds.length;
    stale += observation.returnedIds.filter((memoryId) => forbidden.has(memoryId)).length;
    duplicates += observation.returnedIds.length - unique.size;
    returned += observation.returnedIds.length;
    useful += hits;
    tokens += Math.max(0, observation.contextTokens);
    latencies.push(Math.max(0, observation.latencyMs));
  }
  const count = cases.length;
  return {
    cases: count,
    recallAtK: count ? recall / count : 0,
    precisionAtK: count ? precision / count : 0,
    staleInjectionRate: returned ? stale / returned : 0,
    duplicateRate: returned ? duplicates / returned : 0,
    usefulMemoriesPer1kTokens: tokens ? useful * 1_000 / tokens : 0,
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
  };
}

export function semanticGain(
  lexical: MemoryEvalMetrics,
  hybrid: MemoryEvalMetrics,
): { recallGain: number; precisionGain: number; materiallyBetter: boolean } {
  const recallGain = hybrid.recallAtK - lexical.recallAtK;
  const precisionGain = hybrid.precisionAtK - lexical.precisionAtK;
  return {
    recallGain,
    precisionGain,
    materiallyBetter: recallGain >= 0.1 && hybrid.staleInjectionRate <= lexical.staleInjectionRate,
  };
}
