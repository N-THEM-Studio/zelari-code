/**
 * tools/eval/behavioral.ts — anti-Goodhart behavioural metrics (W2/t45,
 * docs/EVALS.md rule #2).
 *
 * Judge-side companion of the outcome ledger (src/cli/evolution/ledger.ts):
 * SELF-CONTAINED on purpose — judge code never imports product CLI code
 * (same rule as runEvolveDecide's local store reader). The tier weight
 * table is duplicated from ledger.ts (source of truth); keep both in sync —
 * antiGoodhart.test.ts pins the same values.
 *
 * Deterministic by construction: no clock, no LLM, no guessing. The rule is
 * code, not judgement: a variant that raises steer/interrupt rate or lowers
 * the average evidence tier is REJECTED, even when the pass rate improves.
 */
import { existsSync, readFileSync } from 'node:fs';

/**
 * Evidence-tier weights — MUST mirror ledgerStats in
 * src/cli/evolution/ledger.ts (build/tool/command = 1, fs = 0.9, else 0.25).
 */
export const TIER_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  build: 1,
  'tool-output': 1,
  'command-output': 1,
  'fs-observation': 0.9,
  'verifier-llm': 0.25,
  human: 0.25,
  claimed: 0.25,
});

export const MISSING_TIER_WEIGHT = 0.25;

export function tierWeight(tier: string | undefined): number {
  if (typeof tier !== 'string') return MISSING_TIER_WEIGHT;
  return TIER_WEIGHTS[tier] ?? MISSING_TIER_WEIGHT;
}

/** Minimal ledger line shape (tolerant — unknown fields are ignored). */
export interface LedgerLikeEntry {
  at: string;
  taskClass?: string;
  verdict?: string;
  evidenceTier?: string;
  steerCount?: number;
  rollbackUsed?: boolean;
}

export interface BehavioralMetrics {
  /** Total entries in the slice. */
  runs: number;
  /** Entries with verdict PASS|FAIL (the measurable denominator). */
  ratedRuns: number;
  /** Mean steerCount over entries that carry it (undefined when none do). */
  avgSteerCount?: number;
  /** Mean tier weight over RATED entries (undefined when no rated runs). */
  avgTierWeight?: number;
  /** Share of entries with rollbackUsed === true. */
  rollbackRate: number;
}

function isRated(verdict: string | undefined): boolean {
  return verdict === 'PASS' || verdict === 'FAIL';
}

function mean(nums: readonly number[]): number | undefined {
  if (nums.length === 0) return undefined;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function behavioralMetrics(entries: readonly LedgerLikeEntry[]): BehavioralMetrics {
  const rated = entries.filter((e) => isRated(e.verdict));
  return {
    runs: entries.length,
    ratedRuns: rated.length,
    avgSteerCount: mean(
      entries.map((e) => e.steerCount).filter((n): n is number => typeof n === 'number'),
    ),
    avgTierWeight: mean(rated.map((e) => tierWeight(e.evidenceTier))),
    rollbackRate:
      entries.length === 0 ? 0 : entries.filter((e) => e.rollbackUsed === true).length / entries.length,
  };
}

/**
 * Split a ledger into baseline (strictly BEFORE `since`) and variant
 * (at/after `since`) — the boundary is the proposal's createdAt.
 */
export function splitByTime(
  entries: readonly LedgerLikeEntry[],
  sinceIso: string,
): { before: LedgerLikeEntry[]; after: LedgerLikeEntry[] } {
  const before: LedgerLikeEntry[] = [];
  const after: LedgerLikeEntry[] = [];
  for (const e of entries) {
    if (typeof e.at === 'string' && e.at < sinceIso) before.push(e);
    else after.push(e);
  }
  return { before, after };
}

export interface BehavioralVerdict {
  /** true = NOT rejected (rule passed, or not computable — see `skipped`). */
  ok: boolean;
  /** Set when the rule could not be evaluated (insufficient data). */
  skipped?: string;
  /** Rejection reasons (empty when ok). */
  reasons: string[];
}

const EPS = 1e-9;

/**
 * The anti-Goodhart rule (docs/EVALS.md #2), deterministic:
 *   reject when variant.avgSteerCount > baseline.avgSteerCount
 *   reject when variant.avgTierWeight  < baseline.avgTierWeight
 * Only evaluated when BOTH sides have >= minRuns rated runs (default 3) —
 * with less data the rule is `skipped`, never guessed.
 */
export function behavioralVerdict(
  baseline: BehavioralMetrics,
  variant: BehavioralMetrics,
  opts: { minRuns?: number } = {},
): BehavioralVerdict {
  const minRuns = opts.minRuns ?? 3;
  if (baseline.ratedRuns < minRuns || variant.ratedRuns < minRuns) {
    return {
      ok: true,
      skipped: `not computable — need >= ${minRuns} rated runs per side (baseline ${baseline.ratedRuns}, variant ${variant.ratedRuns})`,
      reasons: [],
    };
  }
  const reasons: string[] = [];
  if (
    baseline.avgSteerCount !== undefined &&
    variant.avgSteerCount !== undefined &&
    variant.avgSteerCount > baseline.avgSteerCount + EPS
  ) {
    reasons.push(
      `steer/interrupt rate rose: ${baseline.avgSteerCount.toFixed(3)} -> ${variant.avgSteerCount.toFixed(3)}`,
    );
  }
  if (
    baseline.avgTierWeight !== undefined &&
    variant.avgTierWeight !== undefined &&
    variant.avgTierWeight < baseline.avgTierWeight - EPS
  ) {
    reasons.push(
      `average evidence tier fell: ${baseline.avgTierWeight.toFixed(3)} -> ${variant.avgTierWeight.toFixed(3)}`,
    );
  }
  return { ok: reasons.length === 0, reasons };
}

export interface RotationCandidate {
  taskClass: string;
  failHold: number;
  total: number;
}

/**
 * Hold-out rotation candidates (docs/EVALS.md #3): task classes ranked by
 * FAIL+HOLD recurrence in the ledger — anonymized by construction (class +
 * counts only, never task text). New anchors are authored by a human from
 * these candidates; this function proposes nothing and mutates nothing.
 */
export function rotationCandidates(
  entries: readonly LedgerLikeEntry[],
  limit = 5,
): RotationCandidate[] {
  const byClass = new Map<string, { failHold: number; total: number }>();
  for (const e of entries) {
    const cls = typeof e.taskClass === 'string' && e.taskClass !== '' ? e.taskClass : 'unknown';
    const agg = byClass.get(cls) ?? { failHold: 0, total: 0 };
    agg.total += 1;
    if (e.verdict === 'FAIL' || e.verdict === 'HOLD') agg.failHold += 1;
    byClass.set(cls, agg);
  }
  return [...byClass.entries()]
    .map(([taskClass, agg]) => ({ taskClass, failHold: agg.failHold, total: agg.total }))
    .sort((a, b) => b.failHold - a.failHold || b.total - a.total || a.taskClass.localeCompare(b.taskClass))
    .slice(0, Math.max(0, limit));
}

/**
 * Tolerant JSONL reader (mirrors readLedger in src/cli/evolution/ledger.ts):
 * missing file -> [], corrupt lines skipped, never throws.
 */
export function readLedgerFile(file: string): LedgerLikeEntry[] {
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: LedgerLikeEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (t === '') continue;
    try {
      const parsed: unknown = JSON.parse(t);
      if (parsed !== null && typeof parsed === 'object' && typeof (parsed as LedgerLikeEntry).at === 'string') {
        out.push(parsed as LedgerLikeEntry);
      }
    } catch {
      // corrupt line — skipped, not fatal
    }
  }
  return out;
}
