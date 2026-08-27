/**
 * spawnRoi — t30 (hardening plan §17): orchestration ROI gate.
 *
 * Every tentacle spawn must have positive expected value. A node is worth
 * starting only when its expected success gain outweighs what the spawn costs:
 *
 *   spawnScore = expectedSuccessGain / (cost + latency + duplicationRisk)
 *
 * PURE module — zero fs, zero env, zero clock reads: same input ⇒ same score.
 * Wall-clock time never enters here; recency decay is already baked into the
 * t29 reputation aggregate the executor feeds in (`now` is injected there).
 * The executor owns the policy side: it scores each admitted node before the
 * tentacle starts, vetoes (advisory-first v1) anything below the threshold by
 * sending it back the deferred path — stays READY, never failed — and emits
 * the `node_roi_vetoed` radio trail.
 *
 * Score formula (v1, deterministic):
 *   gain  = verifiedRate * repairFactor * kindWeight
 *     verifiedRate = clamp01(verifiedRate ?? DEFAULT_VERIFIED_RATE)
 *       — unknown history is neither trusted nor punished: 0.7 says "a spawn
 *         with no evidence is presumed useful".
 *     repairFactor = max(REPAIR_FACTOR_FLOOR,
 *                        1 + REPAIR_PENALTY * (avgRepairs ?? DEFAULT_AVG_REPAIRS))
 *       — every historical repair round discounts the gain (rework is the
 *         visible part of a low-quality spawn), floored so even a catastrophic
 *         record keeps a positive gain.
 *     kindWeight   = KIND_WEIGHTS[taskKind]
 *   cost  = money + latency + duplicationRisk * COST_SCALE
 *     money   = (estimatedTokens / 1000 * costUsdPer1k) / COST_NORM_USD when
 *               both estimates exist, else DEFAULT_COST_NORM (unknown prices
 *               like a ~$0.10 run — absence of data ≠ free).
 *     latency = latencyMsEstimate / LATENCY_NORM_MS when known, else
 *               DEFAULT_LATENCY_NORM (unknown ≈ a 5-minute run).
 *   score = gain / max(cost, COST_FLOOR)
 *
 * Calibration (SPAWN_SCORE_THRESHOLD = 0.15): an all-null input scores
 * 0.6475 / 2 ≈ 0.324 — comfortably above the threshold, so the gate SPAWNS on
 * missing data. An advisor that vetoes everything on unknowns is worse than
 * no advisor. The executor passes nulls whenever the reputation bucket has
 * fewer than REPUTATION_MIN_SAMPLE records, so under the default threshold a
 * veto can only happen on reputation-backed evidence (a bad verified-rate
 * bucket) or extreme duplication — never on mere absence of data.
 *
 * Threshold override: the EXECUTOR reads ZELARI_KRAKEN_ROI_THRESHOLD and hands
 * the raw string to {@link parseRoiThreshold}; this module stays env-free.
 *
 * @since v0.10.x — Kraken hardening §17 (P2.F / t30)
 */

import { globsOverlap, normalizeGlob } from './fileOwnership.js';
import { REPUTATION_MIN_SAMPLE } from './modelReputation.js';

/** How a node's work classifies for ROI (executor agent kinds folded). */
export type SpawnRoiTaskKind = 'explore' | 'implement' | 'verify' | 'review';

/** Duplication risk lattice produced by {@link duplicationRiskFor}. */
export type DuplicationRisk = 0 | 0.25 | 0.5 | 1;

export interface SpawnRoiInput {
  /** Raw record count of the (repo, role) reputation bucket (t29 aggregate). */
  reputationSample: number;
  /** Recency-decayed verified rate of the bucket; null when too little sample. */
  verifiedRate: number | null;
  /** Recency-decayed average repair rounds; null when unknown. */
  historicalAvgRepairs: number | null;
  /** Estimated total tokens for the spawn; null when unknown. */
  estimatedTokens: number | null;
  /** Estimated USD per 1000 tokens; null when unknown. */
  costUsdPer1k: number | null;
  /** Estimated wall-clock run duration (ms); null when unknown. */
  latencyMsEstimate: number | null;
  /** {@link duplicationRiskFor} verdict against the racing set. */
  duplicationRisk: DuplicationRisk;
  taskKind: SpawnRoiTaskKind;
}

export interface SpawnScoreComponents {
  /** Numerator: expected success gain (0..~1). */
  gain: number;
  /** Denominator: normalized money + latency + duplication cost. */
  cost: number;
}

export interface SpawnScoreResult {
  score: number;
  components: SpawnScoreComponents;
  /** 'roi-reputation-backed' when a trusted bucket shaped the gain, else 'roi-defaults'. */
  rationaleCode: string;
}

/** Verified rate presumed when history is unknown/too thin to trust. */
export const DEFAULT_VERIFIED_RATE = 0.7;
/** Gain discount per historical repair round (negative: rework discounts). */
export const REPAIR_PENALTY = -0.15;
/** Floor for the repair factor — a terrible record still has nonzero gain. */
export const REPAIR_FACTOR_FLOOR = 0.3;
/** Average repair rounds presumed when unknown. */
export const DEFAULT_AVG_REPAIRS = 0.5;
/** Marginal value of one spawn by task kind (advisory v1 calibration). */
export const KIND_WEIGHTS: Readonly<Record<SpawnRoiTaskKind, number>> = {
  explore: 1.0, // unique information, cheap — never presumptively vetoed
  implement: 1.0, // the task's actual output
  verify: 0.9, // guards quality; a skipped verify can be re-run later
  review: 0.85, // advisory review, least unique output
};
/** An estimated $0.10 run contributes 1.0 cost unit. */
export const COST_NORM_USD = 0.1;
/** Cost-unit contribution of UNKNOWN money (≈ a $0.10 run: unknown ≠ free). */
export const DEFAULT_COST_NORM = 1.0;
/** An estimated 5-minute run contributes 1.0 cost unit. */
export const LATENCY_NORM_MS = 300_000;
/** Cost-unit contribution of UNKNOWN latency (≈ a 5-minute run). */
export const DEFAULT_LATENCY_NORM = 1.0;
/** A fully duplicated spawn (risk 1) adds one full cost unit. */
export const COST_SCALE = 1.0;
/** Denominator floor — a zero-cost spawn cannot divide by zero. */
export const COST_FLOOR = 1e-6;

/**
 * Default spawn threshold: score ≥ threshold spawns. 0.15 keeps the default
 * verdict "spawn" for every unknown-input shape (see the header calibration
 * note). Lower it to gate harder; raise it only once reputation coverage
 * exists, or the gate will veto on missing data.
 */
export const SPAWN_SCORE_THRESHOLD = 0.15;

/** Treat non-finite garbage as "unknown" — NaN must never reach the score. */
function finiteOrNull(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Snap an arbitrary number onto the {@link DuplicationRisk} lattice (nearest point). */
function toDuplicationRisk(v: number | null): DuplicationRisk {
  if (v === null || v <= 0.125) return 0;
  if (v < 0.375) return 0.25;
  if (v < 0.75) return 0.5;
  return 1;
}

/**
 * Deterministic ROI score for one would-be spawn. All-null inputs produce the
 * sane default score (≈ 0.324, see header) — never NaN: every numeric field
 * is sanitized to "unknown" and unknowns have documented defaults.
 */
export function computeSpawnScore(input: SpawnRoiInput): SpawnScoreResult {
  const verified = clamp01(finiteOrNull(input.verifiedRate) ?? DEFAULT_VERIFIED_RATE);
  const repairs = Math.max(0, finiteOrNull(input.historicalAvgRepairs) ?? DEFAULT_AVG_REPAIRS);
  const repairFactor = Math.max(REPAIR_FACTOR_FLOOR, 1 + REPAIR_PENALTY * repairs);
  const kindWeight = KIND_WEIGHTS[input.taskKind] ?? 1;
  const gain = verified * repairFactor * kindWeight;

  const tokens = finiteOrNull(input.estimatedTokens);
  const price = finiteOrNull(input.costUsdPer1k);
  const money =
    tokens !== null && price !== null
      ? Math.max(0, (tokens / 1000) * price) / COST_NORM_USD
      : DEFAULT_COST_NORM;
  const latency = finiteOrNull(input.latencyMsEstimate);
  const latencyNorm =
    latency !== null ? Math.max(0, latency) / LATENCY_NORM_MS : DEFAULT_LATENCY_NORM;
  const dup = toDuplicationRisk(finiteOrNull(input.duplicationRisk));
  const cost = money + latencyNorm + dup * COST_SCALE;

  return {
    score: gain / Math.max(cost, COST_FLOOR),
    components: { gain, cost },
    rationaleCode:
      (finiteOrNull(input.reputationSample) ?? 0) >= REPUTATION_MIN_SAMPLE
        ? 'roi-reputation-backed'
        : 'roi-defaults',
  };
}

/**
 * The gate verdict: spawn at-or-above the threshold (ties spawn — the
 * fail-open direction). A non-finite threshold spawns too: garbage input
 * must never veto work.
 */
export function shouldSpawn(
  scoreResult: SpawnScoreResult,
  threshold: number = SPAWN_SCORE_THRESHOLD,
): boolean {
  if (!Number.isFinite(threshold)) return true;
  return scoreResult.score >= threshold;
}

/**
 * Parse the ZELARI_KRAKEN_ROI_THRESHOLD override. Empty/undefined/invalid or
 * negative values fall back to SPAWN_SCORE_THRESHOLD; anything parseFloat
 * accepts and is finite and ≥ 0 is honored ('0' disables the veto outright).
 */
export function parseRoiThreshold(raw: string | undefined | null): number {
  if (raw === undefined || raw === null) return SPAWN_SCORE_THRESHOLD;
  const s = raw.trim();
  if (s.length === 0) return SPAWN_SCORE_THRESHOLD;
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n) || n < 0) return SPAWN_SCORE_THRESHOLD;
  return n;
}

/** Structural node shape for duplication scoring (`TaskNode` satisfies it). */
export interface DuplicationScopeNode {
  readonly id: string;
  readonly kind: string;
  readonly scope?: readonly string[] | null;
}

/** Kinds that never mutate the workspace (fileOwnership READ_ONLY_KINDS parity). */
const READ_ONLY_KINDS: readonly string[] = ['explore', 'verify', 'spec', 'conformance'];

/**
 * The scope globs a node works on — for duplication (unlike write ownership)
 * this applies to readers too: a missing/empty scope claims the whole tree.
 */
function workScopeOf(node: DuplicationScopeNode): readonly string[] {
  const scope = node.scope;
  if (!scope || scope.length === 0) return ['**'];
  return scope;
}

function isWriterKind(kind: string): boolean {
  return !READ_ONLY_KINDS.includes(kind);
}

/**
 * Duplication-risk heuristic: the chance this spawn repeats work a
 * concurrently-racing node is already doing, from task class + scope overlap.
 * Reuses fileOwnership's globsOverlap/normalizeGlob so both layers agree on
 * what a scope claims (case-folded first, mirroring globsOverlap's default):
 *   0    — no racing node touches this scope;
 *   0.25 — read-only overlap (two readers may duplicate conclusions, but
 *          nothing conflicts);
 *   0.5  — at least one writer is involved on an overlapping (non-identical)
 *          claim;
 *   1    — an identical normalized glob claim (same tree, same kind of work:
 *          near-certain duplicate).
 * Deterministic; the node itself (same id) is excluded from the race set.
 */
export function duplicationRiskFor(
  node: DuplicationScopeNode,
  racing: readonly DuplicationScopeNode[],
): DuplicationRisk {
  let risk: DuplicationRisk = 0;
  // Fold case before normalizing — globsOverlap folds internally, so the
  // identical-claim check must see the same folded form to agree with it.
  const scopeA = workScopeOf(node).map((g) => normalizeGlob(g.toLowerCase()));
  const nodeWrites = isWriterKind(node.kind);
  for (const other of racing) {
    if (!other || other.id === node.id) continue;
    const scopeB = workScopeOf(other).map((g) => normalizeGlob(g.toLowerCase()));
    const overlaps = scopeA.some((a) => scopeB.some((b) => globsOverlap(a, b)));
    if (!overlaps) continue;
    const identical = scopeA.some((a) => scopeB.some((b) => a === b));
    const candidate: DuplicationRisk = identical
      ? 1
      : nodeWrites || isWriterKind(other.kind)
        ? 0.5
        : 0.25;
    if (candidate > risk) risk = candidate;
  }
  return risk;
}
