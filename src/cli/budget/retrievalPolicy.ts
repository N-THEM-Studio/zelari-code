/**
 * retrievalPolicy — budget-aware memory retrieval + skill-catalog gate.
 *
 * ADR-0031/0032: the CLI budget pipeline is the canonical projection
 * compiler and the core memory service stays pressure-blind. This module is
 * the CLI-side translation layer: it maps a measured context occupancy to
 * concrete retrieval knobs (maxChars / maxMemories / scoring weights) and to
 * a skill-catalog gate, so recall precision scales with pressure instead of
 * the flat 2_000-char / 8-memory / default-weights budget every call used to
 * pay. T4 follow-up: signals that already exist, coupled to the decisions
 * that consume them.
 *
 * Bands (occupancy = measured share of the context window):
 * - low    (< 0.50): historical baseline — identical to the old fixed call.
 * - medium (0.50-0.80): tighter packing + precision-first weights.
 * - high   (>= 0.80): minimal packing; recency weight drops to zero.
 */
import type { AgentMessage } from '@zelari/core/harness';
import type { MemoryScoringWeights } from '@zelari/core/memory';
import { estimateHistoryTokens, resolveContextLimit } from './tokenBudget.js';

export type RetrievalPressureBand = 'low' | 'medium' | 'high';

export interface RetrievalPolicy {
  band: RetrievalPressureBand;
  maxChars: number;
  maxMemories: number;
  weights?: Partial<MemoryScoringWeights>;
}

/** Occupancy thresholds shared by recall packing and the skill gate. */
export const RETRIEVAL_PRESSURE_THRESHOLDS = { medium: 0.5, high: 0.8 } as const;

/** Historical fixed call-site values (2_000 chars / 8 memories, core weights). */
export const BASELINE_RETRIEVAL_POLICY: Readonly<RetrievalPolicy> = {
  band: 'low',
  maxChars: 2_000,
  maxMemories: 8,
};

export function retrievalBand(occupancy: number): RetrievalPressureBand {
  const occ = Number.isFinite(occupancy)
    ? Math.max(0, Math.min(1, occupancy))
    : 0;
  if (occ >= RETRIEVAL_PRESSURE_THRESHOLDS.high) return 'high';
  if (occ >= RETRIEVAL_PRESSURE_THRESHOLDS.medium) return 'medium';
  return 'low';
}

/**
 * Precision-first weighting: as pressure rises, spend the shrinking budget on
 * candidates that are semantically on-topic and verified, and stop paying for
 * recency / graph adjacency (they surface candidates the query never asked
 * for). `low` leaves weights undefined so the core defaults apply untouched.
 */
const PRESSURE_WEIGHTS: Record<
  RetrievalPressureBand,
  Partial<MemoryScoringWeights> | undefined
> = {
  low: undefined,
  medium: {
    semanticRelevance: 0.35,
    lexicalRelevance: 0.2,
    importance: 0.15,
    confidence: 0.1,
    recency: 0.05,
    graphProximity: 0.1,
    verificationBonus: 0.05,
  },
  high: {
    semanticRelevance: 0.4,
    lexicalRelevance: 0.25,
    importance: 0.15,
    confidence: 0.1,
    recency: 0,
    graphProximity: 0.05,
    verificationBonus: 0.05,
  },
};

const PRESSURE_PACKING: Record<
  RetrievalPressureBand,
  { maxChars: number; maxMemories: number }
> = {
  low: { maxChars: 2_000, maxMemories: 8 },
  medium: { maxChars: 1_200, maxMemories: 6 },
  high: { maxChars: 600, maxMemories: 4 },
};

export function resolveRetrievalPolicy(occupancy: number): RetrievalPolicy {
  const band = retrievalBand(occupancy);
  const packing = PRESSURE_PACKING[band];
  const weights = PRESSURE_WEIGHTS[band];
  return {
    band,
    ...packing,
    ...(weights ? { weights } : {}),
  };
}

/**
 * Occupancy estimate for hosts that have history but no measured budget yet —
 * same estimator/limit pair the canonical budget pipeline uses.
 */
export function estimateHistoryOccupancy(
  history: readonly AgentMessage[],
  opts?: { model?: string; provider?: string },
): number {
  const limit = resolveContextLimit(opts?.model, opts?.provider);
  return Math.min(1, estimateHistoryTokens(history) / limit);
}

/**
 * Skill-catalog gate: `estimatedCost: 'high'` marks council-driven skills at
 * 2-5x single-LLM API cost. Under high pressure those skills stay loadable
 * by name (the `skill` tool still resolves them) but are hidden from the
 * advertised catalog so the model does not reach for them by default.
 * Generic on purpose: no core import needed to test.
 */
export function filterSkillCatalogByBand<
  T extends { estimatedCost?: string },
>(skills: readonly T[], band: RetrievalPressureBand): T[] {
  if (band !== 'high') return [...skills];
  return skills.filter((s) => s.estimatedCost !== 'high');
}
