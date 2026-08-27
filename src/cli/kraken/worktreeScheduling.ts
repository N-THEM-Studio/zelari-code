/**
 * worktreeScheduling.ts — P2.C: overlap-scored worktree scheduling (pure).
 *
 * P2.A ownership arbitration serializes ANY overlapping pair of writers: the
 * safe default, but it pays the full latency of the first writer before the
 * second starts even when the overlap is thin. The executor already has the
 * isolation machinery to do better (krakenWorktree): a tentacle can run in its
 * own git worktree, and the executor merges worktree branches SEQUENTIALLY
 * (Correction 4 — conflict keeps the branch, never aborts), so two writers in
 * two worktrees can never corrupt each other mid-flight; the only cost of a
 * parallel pair is a possibly-expensive MERGE. That reframes the admission
 * question from "do they overlap?" (binary) to "how much do they overlap?"
 * (graded): thin overlap → the merge is cheap, admit in parallel under
 * isolation; near-identical scopes → the merge conflict would cost more than
 * the serialization, keep the P2.A deferral.
 *
 *   - `estimateOverlapScore(aScopes, bScopes)` — the graded heuristic. Honest
 *     about its granularity: it is a MAX over scope-glob pairs of three values
 *     only — identical (normalized) glob → 1; anything `globsOverlap` calls
 *     overlapping but not identical (ancestor/containment, wildcard claims,
 *     cross-segment globs) → 0.5; disjoint → 0. It does NOT measure how many
 *     files two globs share; it measures whether the overlap is "same claim"
 *     (1, merge = guaranteed conflict) or "different claims that touch" (0.5,
 *     merge = plausible conflict). A wildcard `**` scope scores 0.5 against
 *     anything: undeclared-scope writers are the very case isolation helps,
 *     and `OVERLAP_HIGH_THRESHOLD` is the tuning knob if a repo finds that too
 *     brave.
 *   - `classifyOverlap(score)` — three bands with exported, tunable consts:
 *     score ≥ OVERLAP_HIGH_THRESHOLD (0.75) → 'high' (serialize as today);
 *     score < OVERLAP_LOW_THRESHOLD (0.5) → 'disjoint' (arbitration never
 *     deferred it anyway); in between → 'low' (isolate and admit). The band
 *     that matters in practice is exactly [0.5, 0.75): a node that arbitration
 *     deferred ALWAYS overlaps a racing writer, so its score is ≥ 0.5 — a
 *     "low" band strictly below 0.5 would make parallel admission dead code.
 *   - `worktreeSchedulingDecision(node, racingNodes, env)` — the pure policy
 *     the executor consults for a deferred writer: is the env mode 'auto', is
 *     the node worktree-capable, and is its best overlap score low enough?
 *     Returns a mode plus the score, the rationale code and the racing node
 *     that produced the best score (for telemetry). Reads NO process.env —
 *     the caller passes the env slice in.
 *   - `resolveWorktreeMode(envValue)` — the ZELARI_KRAKEN_WORKTREE value
 *     grammar for scheduling: undefined/''/`0` → 'off', `1`/`true` → 'on',
 *     `auto` → 'auto'; ANYTHING ELSE → 'off' (documented fallback: an
 *     unrecognized value must never widen parallelism). Note 'yes'/'on' enable
 *     worktree CREATION in krakenWorktree but resolve to 'off' here —
 *     scheduling mode stays conservative for unknown values.
 *
 * PURE by contract: no fs, no clock, no process.env reads, no imports beyond
 * fileOwnership (glob semantics are its, never duplicated) and ambient node
 * types. Platform case folding is injected by the caller, like fileOwnership.
 *
 * @since v0.10.x — Kraken worktree scheduling (P2.C / t27)
 */

import {
  globsOverlap,
  normalizeGlob,
  writeScopeOf,
  type ArbitrationOptions,
  type OwnershipNode,
} from './fileOwnership.js';

/**
 * Score assigned to a scope-glob pair that overlaps without being identical
 * (containment, wildcard claims, cross-segment globs). The only non-binary
 * rung of the heuristic — see the module doc for why.
 */
export const PARTIAL_OVERLAP_SCORE = 0.5;

/**
 * At or above this overlap score a parallel pair's merge is presumed too
 * expensive: keep the P2.A sequential deferral. Tunable by design.
 */
export const OVERLAP_HIGH_THRESHOLD = 0.75;

/**
 * Below this score two scopes are disjoint — arbitration never deferred the
 * pair in the first place, so the classifier reports it only for completeness.
 * The 'low' (isolate-and-admit) band is [OVERLAP_LOW_THRESHOLD,
 * OVERLAP_HIGH_THRESHOLD). Tunable by design.
 */
export const OVERLAP_LOW_THRESHOLD = 0.5;

export type OverlapClass = 'disjoint' | 'low' | 'high';

/**
 * Band a 0..1 overlap score falls into: 'high' serializes (as P2.A always
 * did), 'low' may run in parallel under worktree isolation, 'disjoint' never
 * needed either.
 */
export function classifyOverlap(score: number): OverlapClass {
  if (score >= OVERLAP_HIGH_THRESHOLD) return 'high';
  if (score < OVERLAP_LOW_THRESHOLD) return 'disjoint';
  return 'low';
}

/**
 * Estimate how strongly two normalized write-scope sets overlap: 0 (disjoint)
 * .. 1 (same claim). Max over all scope-glob pairs — one hot pair is enough to
 * classify the whole node pair. Deterministic; identical glob pairs
 * short-circuit to 1.
 */
export function estimateOverlapScore(
  aScopes: readonly string[],
  bScopes: readonly string[],
  opts: ArbitrationOptions = {},
): number {
  const fold = opts.caseInsensitive ?? true;
  // Mirror globsOverlap's folding so "identical" and "overlapping" agree on
  // what the caller's filesystem considers the same name.
  const norm = (g: string): string => normalizeGlob(fold ? g.toLowerCase() : g);
  let best = 0;
  for (const a of aScopes) {
    for (const b of bScopes) {
      let score: number;
      if (norm(a) === norm(b)) {
        score = 1; // same claim: the merge would be a guaranteed conflict
      } else if (globsOverlap(a, b, fold)) {
        score = PARTIAL_OVERLAP_SCORE; // different claims that touch
      } else {
        score = 0;
      }
      if (score > best) best = score;
      if (best === 1) return 1;
    }
  }
  return best;
}

/**
 * Kinds whose tentacle the existing worktree machinery can isolate: the
 * `runTentacle` creation path is driven by the `general` agent kind, and the
 * executor maps both `general` and `fix` graph nodes onto it (rework — a `fix`
 * editing an EXISTING worktree — is excluded by the executor's rework map,
 * which this pure module cannot see).
 */
export const WORKTREE_CAPABLE_KINDS: readonly string[] = ['general', 'fix'];

/** True when a node's kind can run inside a git worktree at all. */
export function isWorktreeCapableKind(kind: string): boolean {
  return WORKTREE_CAPABLE_KINDS.includes(kind);
}

export type WorktreeScheduleMode = 'off' | 'on' | 'auto';

/**
 * Resolve the ZELARI_KRAKEN_WORKTREE scheduling mode from a raw env value.
 * `undefined`/''/`0` → 'off' (today's behavior), `1`/`true` → 'on' (always
 * worktree, unchanged), `auto` → 'auto' (scheduler decides per overlap).
 * Anything else → 'off': an unrecognized value must never widen parallelism.
 */
export function resolveWorktreeMode(envValue: string | undefined): WorktreeScheduleMode {
  const v = (envValue ?? '').trim().toLowerCase();
  if (v === 'auto') return 'auto';
  if (v === '1' || v === 'true') return 'on';
  return 'off';
}

export interface WorktreeSchedulingDecision {
  /**
   * 'parallel-worktree' — admit the node now; it runs in its own worktree.
   * 'defer' — keep the P2.A sequential deferral (high overlap, mode not auto,
   * read-only or non-capable node).
   * 'plain-parallel' — no racing writer overlaps it at all; nothing to
   * isolate, the ordinary admission path applies.
   */
  mode: 'defer' | 'parallel-worktree' | 'plain-parallel';
  /** Best overlap score against the racing writers (0 when none). */
  overlapScore: number;
  /** Machine-readable why, for radio/workbench telemetry. */
  rationaleCode:
    | 'worktree-mode-not-auto'
    | 'kind-not-worktree-capable'
    | 'read-only-node'
    | 'no-racing-overlap'
    | 'low-overlap-worktree'
    | 'high-overlap';
  /** Id of the racing writer that produced the best score, when one exists. */
  bestMatchId?: string;
}

/**
 * The P2.C admission policy for one node against the writers it would race
 * with. Pure: the env slice is passed in, never read from process.env.
 *
 * `racingNodes` is the set of writers the node would run alongside — already
 * in flight PLUS admitted this same round (from the scheduler's viewpoint
 * both are running the moment admission returns). Only the 'auto' mode ever
 * yields 'parallel-worktree'; 'off'/'on' modes defer defensively so a caller
 * that skips its own mode check cannot accidentally widen parallelism.
 *
 * Worktree capability is checked per kind here; the caller still owns the
 * per-node state this module cannot see (rework lineage, a caller-level
 * `allowWorktree: false`).
 */
export function worktreeSchedulingDecision(
  node: OwnershipNode,
  racingNodes: readonly OwnershipNode[],
  env: NodeJS.ProcessEnv,
  opts: ArbitrationOptions = {},
): WorktreeSchedulingDecision {
  if (resolveWorktreeMode(env.ZELARI_KRAKEN_WORKTREE) !== 'auto') {
    return { mode: 'defer', overlapScore: 0, rationaleCode: 'worktree-mode-not-auto' };
  }
  const nodeScopes = writeScopeOf(node);
  if (!nodeScopes) {
    // Read-only node: arbitration never defers these anyway; say so honestly.
    return { mode: 'defer', overlapScore: 0, rationaleCode: 'read-only-node' };
  }
  if (!isWorktreeCapableKind(node.kind)) {
    return { mode: 'defer', overlapScore: 0, rationaleCode: 'kind-not-worktree-capable' };
  }
  let best = 0;
  let bestMatchId: string | undefined;
  for (const other of racingNodes) {
    const otherScopes = writeScopeOf(other);
    if (!otherScopes) continue; // read-only racer: never a write conflict
    const score = estimateOverlapScore(nodeScopes, otherScopes, opts);
    if (score > best) {
      best = score;
      bestMatchId = other.id;
    }
    if (best === 1) break;
  }
  if (best === 0) {
    return { mode: 'plain-parallel', overlapScore: 0, rationaleCode: 'no-racing-overlap' };
  }
  if (classifyOverlap(best) === 'low') {
    return {
      mode: 'parallel-worktree',
      overlapScore: best,
      rationaleCode: 'low-overlap-worktree',
      ...(bestMatchId !== undefined ? { bestMatchId } : {}),
    };
  }
  return {
    mode: 'defer',
    overlapScore: best,
    rationaleCode: 'high-overlap',
    ...(bestMatchId !== undefined ? { bestMatchId } : {}),
  };
}
