import type {
  MemoryCandidate,
  MemoryNode,
  RecallResult,
  RecallSignals,
} from './types.js';

export interface MemoryScoringWeights {
  semanticRelevance: number;
  lexicalRelevance: number;
  importance: number;
  confidence: number;
  recency: number;
  graphProximity: number;
  verificationBonus: number;
}

export const DEFAULT_MEMORY_SCORING_WEIGHTS: Readonly<MemoryScoringWeights> = {
  semanticRelevance: 0.30,
  lexicalRelevance: 0.20,
  importance: 0.15,
  confidence: 0.10,
  recency: 0.10,
  graphProximity: 0.10,
  verificationBonus: 0.05,
};

export function memoryTokens(text: string): string[] {
  return text
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

export function lexicalRelevance(query: string, node: MemoryNode): number {
  const queryTokens = new Set(memoryTokens(query));
  if (queryTokens.size === 0) return 0;
  const haystack = new Set(memoryTokens(`${node.content} ${node.tags.join(' ')}`));
  let hits = 0;
  for (const token of queryTokens) {
    if (haystack.has(token)) hits += 1;
  }
  return Math.min(1, hits / Math.max(1, queryTokens.size));
}

export function recencyScore(
  updatedAt: string,
  now = Date.now(),
  halfLifeDays = 30,
): number {
  const at = Date.parse(updatedAt);
  if (!Number.isFinite(at)) return 0;
  const ageDays = Math.max(0, now - at) / 86_400_000;
  return Math.max(0, Math.min(1, Math.pow(0.5, ageDays / halfLifeDays)));
}

function verified(node: MemoryNode): number {
  return node.source.verificationId || node.metadata.verified === true ? 1 : 0;
}

/** Score one candidate, redistributing unavailable semantic weight. */
export function scoreMemoryCandidate(
  candidate: MemoryCandidate,
  query: string,
  options: {
    weights?: Partial<MemoryScoringWeights>;
    now?: number;
    recencyHalfLifeDays?: number;
  } = {},
): RecallResult {
  const node = candidate.node;
  const signals: RecallSignals = {
    semanticRelevance: Math.max(0, Math.min(1, candidate.semanticRelevance ?? 0)),
    lexicalRelevance: Math.max(
      0,
      Math.min(1, candidate.lexicalRelevance ?? lexicalRelevance(query, node)),
    ),
    importance: node.importance,
    confidence: node.confidence,
    recency: recencyScore(node.updatedAt, options.now, options.recencyHalfLifeDays),
    graphProximity: Math.max(0, Math.min(1, candidate.graphProximity ?? 0)),
    verificationBonus: verified(node),
  };
  const weights = { ...DEFAULT_MEMORY_SCORING_WEIGHTS, ...options.weights };
  const semanticAvailable = candidate.semanticRelevance !== undefined;
  const activeEntries = Object.entries(weights).filter(
    ([key]) => semanticAvailable || key !== 'semanticRelevance',
  ) as Array<[keyof MemoryScoringWeights, number]>;
  const totalWeight = activeEntries.reduce((sum, [, weight]) => sum + Math.max(0, weight), 0);
  const weighted = activeEntries.reduce(
    (sum, [key, weight]) => sum + signals[key] * Math.max(0, weight),
    0,
  );
  const score = totalWeight > 0 ? weighted / totalWeight : 0;
  return { node, score: Math.max(0, Math.min(1, score)), signals };
}

export function rankMemoryCandidates(
  candidates: MemoryCandidate[],
  query: string,
  options: Parameters<typeof scoreMemoryCandidate>[2] = {},
): RecallResult[] {
  return candidates
    .map((candidate) => scoreMemoryCandidate(candidate, query, options))
    .sort((a, b) => b.score - a.score || b.node.updatedAt.localeCompare(a.node.updatedAt));
}
