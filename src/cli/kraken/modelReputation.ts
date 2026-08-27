/**
 * modelReputation — t29 (hardening plan §15–16): per-run outcome metrics
 * keyed by (model, provider, repo, language, agent role), the aggregation
 * over them, and the deterministic per-repo ranking that consumers (verifier
 * routing, t21) consult when enough sample exists.
 *
 * PURE module — zero fs, zero clock reads: records carry their own `ts` and
 * callers pass `now` explicitly (defaults kept at the call boundary only for
 * convenience). The append-only JSONL store lives in `reputationStore.ts`;
 * this module only builds/scores/aggregates records so both the runtime
 * executor and tests can inject fixtures freely.
 *
 * Aggregation formula (t29 design contract):
 *   Each record gets a recency weight  w = 2^(−age / REPUTATION_HALF_LIFE_MS)
 *   — exponential decay with a 30-day half-life; future timestamps clamp to
 *   w = 1 (clock skew must not amplify a record). All summary stats are
 *   weighted means over the matching (repo[, role][, model]) bucket:
 *     verifiedRate  = Σ w·[outcome = 'verified']          / Σ w
 *     firstPassRate = Σ w·firstPass                       / Σ w
 *     rejectionRate = Σ w·[outcome = 'review-rejected']   / Σ w
 *     avgRepairs    = Σ w·repairCount                     / Σ w
 *     avgCostUsd    = Σ w·costUsd    over records with non-null cost  / Σ w'
 *     avgLatencyMs  = same, over records with non-null latencyMs
 *   `sample` is the RAW record count in the bucket (thresholds are stated in
 *   whole runs, not decayed mass). Buckets with no cost/latency data report
 *   null averages rather than 0 (absence ≠ free/fast).
 *
 * Ranking score (rankForRepo):  score = verifiedRate / max(avgCostUsd, ε)
 * — quality per USD, with ε = COST_EPSILON_USD guarding the zero-cost case.
 * Records without usage data are cost-unknown and therefore rank with a
 * near-zero denominator (documented v1 caveat: cost coverage grows as usage
 * reporting becomes consistent). Candidates below REPUTATION_MIN_SAMPLE are
 * never ranked — the caller falls back to its existing heuristics.
 */

/** Terminal outcome of one (node) run attributed to a model. */
export type ReputationOutcome = 'verified' | 'failed' | 'repaired' | 'review-rejected';

export const REPUTATION_OUTCOMES: readonly ReputationOutcome[] = [
  'verified',
  'failed',
  'repaired',
  'review-rejected',
];

/** One recorded run. Append-only store row (see reputationStore.ts). */
export interface ReputationRecord {
  /** Epoch ms when the run settled. */
  ts: number;
  /** Repo identity (v1: basename of the workspace root). */
  repo: string;
  /** Model that ran the node, when known; null when not resolvable at the seam. */
  model: string | null;
  /** Provider family identity, when known; null when not carried by the result. */
  provider: string | null;
  /** Host agent role ('explore' | 'general' | 'verify' in v1). */
  role: string;
  /** Primary language when cheaply derivable; null otherwise (v1: always null). */
  language: string | null;
  outcome: ReputationOutcome;
  /** True when the run needed no retry/repair to reach its terminal state. */
  firstPass: boolean;
  /** Retries/rework rounds consumed before the terminal state. */
  repairCount: number;
  /** Provider-reported USD cost when computable; null otherwise (never guessed). */
  costUsd: number | null;
  /** Wall-clock run duration in ms when known; null otherwise. */
  latencyMs: number | null;
}

/** Bucket selector for aggregation: repo required, role/model optional. */
export interface ReputationKey {
  repo: string;
  role?: string;
  model?: string;
}

export interface ReputationSummary {
  /** Raw number of records in the bucket. */
  sample: number;
  verifiedRate: number;
  firstPassRate: number;
  avgRepairs: number;
  avgCostUsd: number | null;
  avgLatencyMs: number | null;
  rejectionRate: number;
}

/** Recency half-life for decayed aggregation: 30 days. */
export const REPUTATION_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/** Minimum bucket sample before a ranking is trusted (t29 contract: ~5). */
export const REPUTATION_MIN_SAMPLE = 5;

/** Guards the score division when a bucket's average cost is 0/null. */
export const COST_EPSILON_USD = 1e-6;

/**
 * Recency weight of one record: 2^(−age/halfLife), clamped so future-dated
 * records (clock skew) never weigh more than the present.
 */
export function decayWeight(ts: number, now: number): number {
  const age = Math.max(0, now - ts);
  return Math.pow(2, -age / REPUTATION_HALF_LIFE_MS);
}

function matchesKey(rec: ReputationRecord, key: ReputationKey): boolean {
  if (rec.repo !== key.repo) return false;
  if (key.role !== undefined && rec.role !== key.role) return false;
  if (key.model !== undefined && rec.model !== key.model) return false;
  return true;
}

/** Weighted (recency-decayed) summary over one bucket. */
export function aggregate(
  records: readonly ReputationRecord[],
  key: ReputationKey,
  now: number = Date.now(),
): ReputationSummary {
  const bucket = records.filter((r) => matchesKey(r, key));
  if (bucket.length === 0) {
    return {
      sample: 0,
      verifiedRate: 0,
      firstPassRate: 0,
      avgRepairs: 0,
      avgCostUsd: null,
      avgLatencyMs: null,
      rejectionRate: 0,
    };
  }
  let totalW = 0;
  let verifiedW = 0;
  let firstPassW = 0;
  let rejectedW = 0;
  let repairsW = 0;
  let costW = 0;
  let costSumW = 0;
  let latencyW = 0;
  let latencySumW = 0;
  for (const r of bucket) {
    const w = decayWeight(r.ts, now);
    totalW += w;
    if (r.outcome === 'verified') verifiedW += w;
    if (r.outcome === 'review-rejected') rejectedW += w;
    if (r.firstPass) firstPassW += w;
    repairsW += w * r.repairCount;
    if (r.costUsd !== null && Number.isFinite(r.costUsd)) {
      costSumW += w * r.costUsd;
      costW += w;
    }
    if (r.latencyMs !== null && Number.isFinite(r.latencyMs)) {
      latencySumW += w * r.latencyMs;
      latencyW += w;
    }
  }
  const safeTotal = totalW > 0 ? totalW : 1;
  return {
    sample: bucket.length,
    verifiedRate: verifiedW / safeTotal,
    firstPassRate: firstPassW / safeTotal,
    avgRepairs: repairsW / safeTotal,
    avgCostUsd: costW > 0 ? costSumW / costW : null,
    avgLatencyMs: latencyW > 0 ? latencySumW / latencyW : null,
    rejectionRate: rejectedW / safeTotal,
  };
}

/** One ranked candidate: quality-per-USD plus the sample it rests on. */
export interface ReputationRanked {
  provider: string;
  model: string;
  score: number;
  sample: number;
}

export interface RankForRepoOptions {
  repo: string;
  role?: string;
  /** Candidate identities to rank (already family-filtered by the caller). */
  candidates: readonly { provider: string; model: string }[];
  now?: number;
}

/**
 * Deterministic per-repo ranking over `candidates`.
 *
 * score = verifiedRate / max(avgCostUsd, COST_EPSILON_USD) per candidate
 * bucket (repo + role + model). Candidates with sample < REPUTATION_MIN_SAMPLE
 * are dropped; when NO candidate reaches the threshold the caller must fall
 * back, so null is returned. Ordering: score desc, then provider asc, then
 * model asc — fully deterministic, no wall-clock or locale dependence.
 */
export function rankForRepo(
  records: readonly ReputationRecord[],
  opts: RankForRepoOptions,
): ReputationRanked[] | null {
  const seenModels = new Set<string>();
  const ranked: ReputationRanked[] = [];
  for (const c of opts.candidates) {
    if (!c.model || seenModels.has(c.model)) continue;
    seenModels.add(c.model);
    const s = aggregate(records, { repo: opts.repo, role: opts.role, model: c.model }, opts.now);
    if (s.sample < REPUTATION_MIN_SAMPLE) continue;
    const denominator = Math.max(s.avgCostUsd ?? 0, COST_EPSILON_USD);
    ranked.push({ provider: c.provider, model: c.model, score: s.verifiedRate / denominator, sample: s.sample });
  }
  if (ranked.length === 0) return null;
  ranked.sort((a, b) =>
    b.score !== a.score
      ? b.score - a.score
      : a.provider !== b.provider
        ? (a.provider < b.provider ? -1 : 1)
        : a.model < b.model
          ? -1
          : 1,
  );
  return ranked;
}

/**
 * Router-facing convenience (used by verifierRouting t29): the top-ranked
 * candidate within an already family-constrained pool, or null when there is
 * no trusted sample (records null/empty, repo unknown, or every candidate
 * below REPUTATION_MIN_SAMPLE). Null means "caller falls back" — never an
 * arbitrary pick.
 */
export function reputationFamilyPick(
  records: readonly ReputationRecord[] | null,
  pool: readonly { provider: string; model: string }[],
  repo: string | null,
): { provider: string; model: string } | null {
  if (!records || records.length === 0 || !repo || pool.length === 0) return null;
  const ranked = rankForRepo(records, { repo, role: 'verify', candidates: pool });
  if (!ranked || ranked.length === 0) return null;
  return { provider: ranked[0]!.provider, model: ranked[0]!.model };
}

/** Node kinds that run as reviewer agents (executor.isReviewerKind parity). */
export const REPUTATION_REVIEWER_KINDS: readonly string[] = ['verify', 'spec', 'conformance'];

export interface NodeReputationInput {
  repo: string;
  /** Host agent role the node ran as (executor.agentForNode parity). */
  role: string;
  /** Graph node kind (pre role-mapping). */
  kind: string;
  ok: boolean;
  /** Parsed verify-report verdict, only for reviewer kinds; else null. */
  reviewerVerdict: 'pass' | 'fail' | 'unknown' | null;
  repairCount: number;
  model: string | null;
  provider: string | null;
  costUsd: number | null;
  latencyMs: number | null;
  ts?: number;
}

/**
 * Pure mapping from one settled node run to a reputation record (t29
 * contract): ok ⇒ 'verified' (non-reviewer) or per verify verdict for
 * reviewers (pass → 'verified', fail → 'review-rejected'); repairs > 0 ⇒
 * 'repaired'; failure ⇒ 'failed'. An INCONCLUSIVE reviewer verdict maps to
 * 'failed' on purpose — unknown ≠ pass (ADR-0023), and a reviewer that
 * cannot decide must not inflate its verified rate. Cancelled runs are
 * filtered out by the executor seam (cancellation is not a model signal).
 */
export function reputationRecordFromNodeRun(input: NodeReputationInput): ReputationRecord {
  const isReviewer = REPUTATION_REVIEWER_KINDS.includes(input.kind);
  let outcome: ReputationOutcome;
  if (!input.ok) {
    outcome = 'failed';
  } else if (isReviewer && input.reviewerVerdict === 'fail') {
    outcome = 'review-rejected';
  } else if (isReviewer && input.reviewerVerdict === 'unknown') {
    outcome = 'failed';
  } else if (input.repairCount > 0) {
    outcome = 'repaired';
  } else {
    outcome = 'verified';
  }
  return {
    ts: input.ts ?? Date.now(),
    repo: input.repo,
    model: input.model,
    provider: input.provider,
    role: input.role,
    language: null, // v1: language is not cheaply derivable at the seam.
    outcome,
    firstPass: input.ok && input.repairCount === 0,
    repairCount: input.repairCount,
    costUsd: input.costUsd,
    latencyMs: input.latencyMs,
  };
}
