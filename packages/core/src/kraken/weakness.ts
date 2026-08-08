/**
 * Kraken graph engine — weakness-based hypothesis ranking (Bennett 2023).
 *
 * "The Optimal Choice of Hypothesis Is the Weakest, Not the Shortest"
 * Michael Timothy Bennett, AGI 2023 — arXiv:2301.12987v4.
 *
 * Bennett's formal result, restated for a coding-agent context:
 *
 *   In a lattice of declarative programs, the **weakness** of a statement
 *   `l` is the cardinality of its extension `|Z_l|` — the number of
 *   statements `l` is a sub-statement of. For an unknown parent task
 *   `ω` of a known child `α`, the probability of a model `h ∈ M_α`
 *   generalising to `ω` is
 *
 *       p(h ∈ M_ω | h ∈ M_α, α ⊏ ω) = 2^|Z_{S_α} ∩ Z_h| / 2^|Z_{S_α}|
 *
 *   which is monotonically increasing in `|Z_h|`. The weakest sufficient
 *   hypothesis maximises the probability of generalisation — and in
 *   Bennett's experiments (binary 8-bit add / mult) weakness generalised
 *   at 1.1×–5× the rate of MDL (Occam's Razor as length).
 *
 *   "Explanations should be no more specific than necessary."
 *                                                  — Bennett's Razor
 *
 * For a natural-language plan we can't compute `|Z_h|` exactly. This
 * module provides three usable approximations, cheapest first:
 *
 *   1. `weaknessFromVerdict(text)` — heuristic string scan for
 *      "specificity markers" (e.g. "exactly", "must", "always",
 *      "guaranteed", "line N"). Catches gross over-claiming, free.
 *   2. `measureSpecificity(text)` — caller-agnostic shape of an LLM
 *      meter prompt; the CLI uses {@link WEAKNESS_METER_PROMPT} plus a
 *      model call to get a principled specificity score.
 *   3. `extensionSize` (if a caller computes it themselves) — feeds
 *      `rankByWeakness` directly.
 *
 * `rankByWeakness(candidates)` is the single ranking entry point; it
 * combines the three into a normalised weakness score in `[0, 1]`.
 *
 * No CLI dependencies (see CORREZIONE-1 in the engine plan).
 *
 * @since v1.31.x — weakness-based hypothesis selection
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Bennett's Razor
// ---------------------------------------------------------------------------

/**
 * Bennett's Razor in one sentence, suitable for inclusion in system prompts.
 *
 * "Explanations should be no more specific than necessary." — Bennett 2023.
 *
 * The expanded form below spells out the operational meaning: when two
 * solutions both satisfy a task, prefer the one that makes fewer specific
 * claims about the world. It is deliberately phrased as a *tie-breaker*,
 * not a goal in itself — a plan that is too weak to act on is still useless.
 */
export const BENNETTS_RAZOR = [
  "Bennett's Razor (arXiv:2301.12987): explanations should be no more specific than necessary.",
  'When two solutions both satisfy the task, prefer the one that assumes the least.',
  'A claim is "more specific" when it pins down an exact value, path, version, or invariant that a more general plan would not have to commit to.',
  'Specificity is a tie-breaker, not a goal: a plan that is too vague to act on is still useless.',
  'Weakness ranking only applies among solutions that already meet the bar; do not weaken a passing plan below the bar in the name of weakness.',
].join(' ');

/**
 * Short form — a single sentence, for inclusion in compact prompts.
 */
export const BENNETTS_RAZOR_SHORT =
  'Prefer the solution that is no more specific than necessary.';

// ---------------------------------------------------------------------------
// Heuristic specificity scan (no LLM call, deterministic)
// ---------------------------------------------------------------------------

/**
 * Lexical markers that correlate with a *specific* claim. Each match adds a
 * small weight to {@link SPECIFICITY_MARKER_WEIGHT}; the sum is clamped to
 * `[0, 1]` after the scan.
 *
 * The list is intentionally small and conservative: false positives in the
 * "specific" direction (under-ranking a weak plan) are worse than false
 * positives in the "general" direction, because a too-weak plan is just
 * under-rendered in the workbench, while a too-strong one may be chosen
 * over a better one.
 */
const SPECIFICITY_MARKERS: readonly RegExp[] = [
  /\bguarantee[ds]?\b/i,
  /\bexact(?:ly)?\b/i,
  /\bmust\b/i,
  /\bshall\b/i,
  /\balways\b/i,
  /\bnever\b/i,
  /\brequire[ds]?\b/i,
  /\bmandatory\b/i,
  /\bline\s+\d+/i,         // "line 42"
  /\bversion\s+[\d.]+/i,   // "version 1.2.3"
  /\bv?\d+\.\d+\.\d+\b/,   // bare semver
  /\b[0-9a-f]{7,40}\b/i,   // git short SHA / commit hash
  /\bthe\s+(?:file|path)\s+(?:is|at)\b/i,
  /\bprecise(?:ly)?\b/i,
  /\bassert(?:s|ed|ion)?\b/i,
  /\bconfirm(?:s|ed)?\b/i,
  /\bwill\s+(?:definitely|certainly|always)\b/i,
];

/** Per-marker weight. Chosen so ~3 matches already saturate the score. */
const SPECIFICITY_MARKER_WEIGHT = 0.25;

/**
 * Per-claim count penalty. Every *new sentence containing a verb* adds a
 * tiny weight. This catches the "I will do A, then B, then C, then D"
 * pattern that no individual marker hits but is clearly over-specified.
 */
const SPECIFICITY_CLAUSE_WEIGHT = 0.05;

/** Maximum number of clause-penalty increments (caps runaway). */
const SPECIFICITY_CLAUSE_MAX = 6;

/**
 * Compute a heuristic `specificity` score in `[0, 1]` for `text`.
 *
 * Returns `0` for an empty / whitespace-only string (a maximally weak claim).
 * A score of `1` means "highly specific — many marker hits and/or many
 * clauses"; a score of `0` means "no specificity signals at all".
 */
export function weaknessFromVerdict(text: string | undefined | null): number {
  if (typeof text !== 'string') return 0;
  const trimmed = text.trim();
  if (trimmed === '') return 0;

  let score = 0;
  for (const re of SPECIFICITY_MARKERS) {
    if (re.test(trimmed)) score += SPECIFICITY_MARKER_WEIGHT;
  }

  // Clause count: count sentences / semicolon-separated statements with a verb.
  const clauses = trimmed
    .split(/[.!?;]+|\n+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && /\b\w+ing\b|\b\w+ed\b|\bwill\b|\bcan\b|\bmust\b|\bshould\b|\bmay\b/i.test(c));
  const clausePenalty = Math.min(clauses.length, SPECIFICITY_CLAUSE_MAX) * SPECIFICITY_CLAUSE_WEIGHT;
  score += clausePenalty;

  return clamp01(score);
}

/**
 * Weakness = `1 - specificity`, in `[0, 1]`. The default tie-breaker
 * when no `extensionSize` or LLM meter is available.
 */
export function weaknessScoreFromText(text: string | undefined | null): number {
  return 1 - weaknessFromVerdict(text);
}

// ---------------------------------------------------------------------------
// LLM-as-weakness-meter
// ---------------------------------------------------------------------------

/**
 * The meter prompt. A caller wraps this with their own model invocation
 * (see `src/cli/kraken/weaknessMeter.ts`) and parses the JSON response.
 *
 * Kept as a string here (not a function) so it can be snapshotted in
 * tests and re-used across providers without re-importing the CLI.
 */
export const WEAKNESS_METER_PROMPT = `You are measuring the SPECIFICITY of a candidate solution to a software task.

Specificity means: how many specific commitments does this solution make that a more general plan would not have to make? Examples of specific commitments: exact file paths, exact line numbers, exact semver versions, exact function signatures, guarantees about runtime behaviour, assertions about what other agents/users will do.

A maximally general solution is one that asserts nothing beyond the task itself ("just do the task"). A maximally specific solution is one that pins every possible value, path, and invariant.

Output ONLY a JSON object of the form:
{"specificity": <float in [0,1]>, "assumptions": [<short string>, ...]}

where
- specificity = 0.0  → solution asserts nothing beyond the task
- specificity = 1.0  → solution pins every value, path, version, and invariant
- assumptions = the list of specific commitments you identified, each ≤ 12 words, deduped, sorted by strength (most specific first). Cap the list at 12.

Do not add prose, do not add a code fence, do not explain your reasoning. JSON only.`;

/**
 * Zod schema for the meter response. Use this in the CLI to parse the
 * model's output — gives type safety + a clear error path for malformed
 * JSON, which is the most common failure mode of meter calls.
 */
export const WeaknessMeterResponseSchema = z.object({
  specificity: z.number().min(0).max(1),
  assumptions: z.array(z.string().min(1).max(200)).max(12),
});
export type WeaknessMeterResponse = z.infer<typeof WeaknessMeterResponseSchema>;

/**
 * Convenience: turn a meter response into a weakness score in `[0, 1]`.
 * Pure: no I/O. The meter itself is the only thing that costs.
 */
export function weaknessFromMeter(meter: WeaknessMeterResponse): number {
  return clamp01(1 - clamp01(meter.specificity));
}

/**
 * Convenience: turn an `assumptions` list (from a meter response) into a
 * heuristic *specificity* score. Used as a fallback when the meter returns
 * a `specificity` outside `[0,1]` or one of the JSON fields is missing
 * after parsing. Each assumption is treated as one specificity hit.
 */
export function specificityFromAssumptions(assumptions: readonly string[]): number {
  if (!Array.isArray(assumptions) || assumptions.length === 0) return 0;
  // 1 assumption = low specificity; 6+ = saturate. Empirically: most
  // reasonable solutions have 0–6 real assumptions; beyond that the
  // plan is almost certainly over-specified.
  const raw = Math.min(assumptions.length, 6) / 6;
  return clamp01(raw);
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * A hypothesis / plan / skill candidate. At least one of the weakness
 * signals should be populated; `rankByWeakness` will use the strongest
 * signal available.
 */
export interface HypothesisCandidate {
  /** Stable id (writer node id, skill name, plan hash, …). */
  id: string;
  /** The text we may scan heuristically if no other signal is set. */
  text?: string;
  /**
   * Optional: caller's pre-computed extension size `|Z_h|`. When set,
   * overrides everything else. Use this if you have a real lattice
   * representation (Kraken's Spec Council does not, today).
   */
  extensionSize?: number;
  /**
   * Optional: result of {@link WeaknessMeterResponseSchema}.parsed.
   * Overrides the heuristic scan.
   */
  meter?: WeaknessMeterResponse;
}

/** A candidate plus the score it received. */
export interface RankedHypothesis<T extends HypothesisCandidate = HypothesisCandidate> {
  candidate: T;
  /** Normalised weakness score in `[0, 1]`. Higher = weaker = more general. */
  weaknessScore: number;
  /** 1-based rank, weakest first. Ties get the same rank. */
  rank: number;
  /** Which signal drove the score (for debugging / auditing). */
  source: 'extensionSize' | 'meter' | 'heuristic';
}

/**
 * Rank candidates by weakness, weakest first. Stable: equal scores keep
 * input order. The function is pure and synchronous; no LLM, no I/O.
 *
 * Strategy per candidate:
 *   1. `extensionSize` (raw count) → normalised across the candidate set
 *      to `[0, 1]` by dividing by the max within the set.
 *   2. `meter.specificity` → `1 - specificity` if present and valid.
 *   3. `weaknessScoreFromText(candidate.text)` → heuristic.
 *   4. `0` if nothing is set (the candidate is "as general as the empty claim").
 */
export function rankByWeakness<T extends HypothesisCandidate>(candidates: readonly T[]): RankedHypothesis<T>[] {
  if (candidates.length === 0) return [];

  // Pass 1: compute raw per-source scores so we can normalise extensionSize
  // against the *current* candidate set (it is not a unit-free number).
  type Raw<T2 extends HypothesisCandidate> = {
    candidate: T2;
    raw: number;
    source: RankedHypothesis<T2>['source'];
  };
  const raws: Raw<T>[] = candidates.map((c) => computeRaw(c));

  const extScores = raws.filter((r) => r.source === 'extensionSize').map((r) => r.raw);
  const extMax = extScores.length > 0 ? Math.max(...extScores) : 1;
  const extMin = extScores.length > 0 ? Math.min(...extScores) : 0;
  const extRange = extMax - extMin;

  const scored: { candidate: T; score: number; source: RankedHypothesis<T>['source'] }[] = raws.map(
    (r) => {
      let score: number;
      switch (r.source) {
        case 'extensionSize':
          // Normalise within-set. If all extensionSize are equal, every
          // candidate gets the same normalised score (the max), which
          // preserves "they're all equally weak" → stable order.
          score = extRange > 0 ? (r.raw - extMin) / extRange : 1;
          break;
        case 'meter':
          score = clamp01(1 - clamp01(r.raw));
          break;
        case 'heuristic':
          score = clamp01(r.raw);
          break;
      }
      return { candidate: r.candidate, score, source: r.source };
    },
  );

  // Pass 2: stable sort by score desc, then by input order.
  const indexed = scored.map((s, i) => ({ ...s, originalIndex: i }));
  indexed.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.originalIndex - b.originalIndex;
  });

  // Pass 3: assign 1-based ranks with ties. Equal scores → same rank; the
  // next distinct score jumps to reflect the count of earlier ties.
  let lastScore: number | undefined;
  let lastRank = 0;
  let seen = 0;
  return indexed.map((s) => {
    seen += 1;
    if (lastScore === undefined || s.score !== lastScore) {
      lastRank = seen;
      lastScore = s.score;
    }
    return {
      candidate: s.candidate,
      weaknessScore: s.score,
      rank: lastRank,
      source: s.source,
    };
  });
}

function computeRaw<T extends HypothesisCandidate>(
  c: T,
): { candidate: T; raw: number; source: RankedHypothesis<T>['source'] } {
  if (typeof c.extensionSize === 'number' && Number.isFinite(c.extensionSize) && c.extensionSize >= 0) {
    return { candidate: c, raw: c.extensionSize, source: 'extensionSize' };
  }
  if (c.meter && typeof c.meter.specificity === 'number' && Number.isFinite(c.meter.specificity)) {
    return { candidate: c, raw: clamp01(c.meter.specificity), source: 'meter' };
  }
  return { candidate: c, raw: weaknessScoreFromText(c.text), source: 'heuristic' };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Pick the weakest candidate (rank 1) from a list. Convenience for the
 * Spec Council's "all PASS, pick one" branch. Returns `undefined` if the
 * input is empty.
 */
export function pickWeakest<T extends HypothesisCandidate>(candidates: readonly T[]): T | undefined {
  const ranked = rankByWeakness(candidates);
  return ranked.length > 0 ? ranked[0].candidate : undefined;
}

/**
 * Filter candidates to those with weakness ≥ `threshold` (in `[0, 1]`).
 * Useful for "among all PASS solutions, keep only the ones that are
 * *enough* general" — e.g. drop a solution whose heuristic scan flags
 * ≥ 4 specific markers.
 */
export function filterByWeakness<T extends HypothesisCandidate>(
  candidates: readonly T[],
  threshold: number,
): T[] {
  const ranked = rankByWeakness(candidates);
  return ranked.filter((r) => r.weaknessScore >= threshold).map((r) => r.candidate);
}
