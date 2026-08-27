/**
 * orchestration/policy — deterministic OrchestrationDecision v2 for
 * `--mode auto` (t12 / P1.1 → t23 / P1.E).
 *
 * Given a raw task prompt plus CHEAP FACTS (contract risk/scope via the t22
 * contractCompiler seam, bounded repo file-count, recent verification
 * failures), decide which strategy owns the run and which dispatch surface
 * executes it. DETERMINISTIC FIRST: identical inputs always yield an
 * identical decision; no clock, no randomness, no I/O, no environment reads,
 * and the LLM plays no part anywhere.
 *
 * ── DECISION TABLE (first match wins) ──────────────────────────────────────
 *  #  condition                                          strategy        code
 *  0  empty/whitespace prompt                            lead-only       fail_closed_empty
 *  1  DESIGN_RE ∧ AMBIGUOUS_RE                           council         design_conflict_signal
 *  2  contract risk high|critical                        graph           contract_high_risk
 *  3  CROSS_CUTTING_RE                                   graph           cross_cutting_scope
 *  4  MULTI_ARTIFACT_RE ("4 files")                      parallel-build  multi_artifact_count
 *  5  scope paths ≥ PARALLEL_SCOPE_PATHS                 parallel-build  multi_path_scope
 *  6  HEAVY_SIGNALS (impl/refactor/migrate/new-cap/tests)
 *                                                     → lead+verify    (signal code)
 *  7  AMBIGUOUS_RE alone                                 explore         ambiguous_task
 *  8  READONLY_RE                                        explore         read_only_request
 *  9  QUESTION_RE                                        lead-only       question_shaped_task
 * 10  EXPLAIN_RE                                         lead-only       explanation_request
 * 11  ≤ maxSoloChars ∧ small scope ∧ no failures ∧
 *     low risk ∧ not-large repo                         lead-only       small_task_no_heavy_signals
 * 12  else (long neutral)                                lead-only       fail_closed_default   ← v1 parity
 *
 * Post-adjustment (escalation-only, monotonic in STRATEGY_RANK):
 *   previousFailures ≥ 2          → graph            repeated_verification_failures
 *   previousFailures == 1 & solo  → at least lead+verify  prior_failure_verification_bump
 *
 * Fail-closed discipline from v1 is preserved: absent signals the answer is
 * the historical default (solo / lead-only), never a speculative escalation.
 * Council has exactly ONE trigger (rule 1) — see signals.DESIGN_RE docs.
 *
 * Mode wiring (runHeadless): lead-only|explore → single-harness solo path;
 * lead+verify|parallel-build|graph → kraken path + mapped delegation policy;
 * council → council pipeline forced to the LITE tier unless ZELARI_COUNCIL_* env opts out.
 */
import type { TaskRisk } from '@zelari/core';
import {
  AMBIGUOUS_RE,
  CROSS_CUTTING_RE,
  DESIGN_RE,
  ESTIMATED_LATENCY_MS,
  EXPLAIN_RE,
  HEAVY_SIGNALS,
  MULTI_ARTIFACT_RE,
  QUESTION_RE,
  READONLY_RE,
  STRATEGY_RANK,
  strategySurface,
  type OrchestrationStrategy,
  type OrchestrationSurface,
} from './signals.js';

export type { OrchestrationStrategy, OrchestrationSurface };

/** Human-readable twins of the rationaleCodes (safe to log verbatim). */
const RATIONALE_TEXT: Readonly<Record<string, string>> = {
  fail_closed_empty: 'empty task',
  design_conflict_signal: 'design + ambiguity conflict',
  contract_high_risk: 'high-risk contract',
  cross_cutting_scope: 'cross-cutting scope',
  multi_artifact_count: 'multi-artifact count',
  multi_path_scope: 'multi-path contract scope',
  ambiguous_task: 'ambiguous task',
  question_shaped_task: 'question-shaped task',
  explanation_request: 'explanation request',
  read_only_request: 'read-only request',
  small_task_no_heavy_signals: 'small task, no heavy signals',
  fail_closed_default: 'fail-closed default',
  repeated_verification_failures: 'repeated verification failures',
  prior_failure_verification_bump: 'prior failure verification bump',
};

/** Per-rule confidence constants (heuristics — documented, stable, pure). */
const RATIONALE_CONFIDENCE: Readonly<Record<string, number>> = {
  fail_closed_empty: 0.35,
  design_conflict_signal: 0.8,
  contract_high_risk: 0.85,
  cross_cutting_scope: 0.75,
  multi_artifact_count: 0.7,
  multi_path_scope: 0.7,
  implementation_signal: 0.72,
  refactor_signal: 0.72,
  migration_signal: 0.75,
  new_capability_signal: 0.7,
  test_writing_signal: 0.7,
  ambiguous_task: 0.55,
  read_only_request: 0.65,
  question_shaped_task: 0.6,
  explanation_request: 0.6,
  small_task_no_heavy_signals: 0.62,
  fail_closed_default: 0.3,
  repeated_verification_failures: 0.78,
  prior_failure_verification_bump: 0.66,
};

/**
 * Prompts at or under this length with no signal matched are treated as
 * small (v1 constant kept for compat). Larger neutral prompts still fall
 * through to the fail-closed default — never escalate on size alone.
 */
export const DEFAULT_MAX_SOLO_CHARS = 300;

/** Contract-scope path count that implies several disjoint slices. */
export const PARALLEL_SCOPE_PATHS = 3;

export interface OrchestrationPolicyOpts {
  /** v1 budget override (see DEFAULT_MAX_SOLO_CHARS). */
  maxSoloChars?: number;
  /** Active TaskContract risk via the contractCompiler seam (t22). */
  risk?: TaskRisk;
  /** Total glob paths declared in the active contract scope (0 when none). */
  scopePathsCount?: number;
  /** Bounded workspace file count (collectOrchestrationFacts). */
  repoSize?: number;
  /** Recent spine verification failures; callers pass 0 pre-spine today. */
  previousFailures?: number;
}

export interface OrchestrationVerdict {
  surface: OrchestrationSurface;
  /** Short stable human explanation; safe to log verbatim. */
  reason: string;
}

export interface OrchestrationDecision extends OrchestrationVerdict {
  /** Fine-grained v2 strategy (see signals.ts ladder). */
  strategy: OrchestrationStrategy;
  /** Heuristic confidence in [0,1] per rule constant table. */
  confidence: number;
  /** Stable machine code (DECISION TABLE column "code"); safe to assert on. */
  rationaleCode: string;
  /**
   * ORDER-OF-MAGNITUDE latency heuristic in ms (unit documented on
   * ESTIMATED_LATENCY_MS) — monotonic with complexity rank, NOT a prediction.
   */
  estimatedLatencyMs: number;
}

const HEAVY_CODES = new Set([
  'implementation_signal',
  'refactor_signal',
  'migration_signal',
  'new_capability_signal',
  'test_writing_signal',
]);

/**
 * Classify a task into a full v2 OrchestrationDecision. Pure function:
 * identical inputs always yield identical outputs (property-tested).
 */
export function chooseOrchestration(
  task: string,
  opts: OrchestrationPolicyOpts = {},
): OrchestrationDecision {
  const text = String(task ?? '').trim();

  let hit = !text
    ? hitOf('lead-only', 'fail_closed_empty')
    : baseRule(text, opts);

  // Failure post-adjustment — escalation only (never lowers, never touches a
  // council decision: councils are not verification tools).
  if (hit.strategy !== 'council' && (opts.previousFailures ?? 0) > 0) {
    if ((opts.previousFailures ?? 0) >= 2 && STRATEGY_RANK[hit.strategy] < STRATEGY_RANK.graph) {
      hit = hitOf('graph', 'repeated_verification_failures');
    } else if (
      (opts.previousFailures ?? 0) >= 1 &&
      STRATEGY_RANK[hit.strategy] < STRATEGY_RANK['lead+verify']
    ) {
      hit = hitOf('lead+verify', 'prior_failure_verification_bump');
    }
  }

  return {
    ...hit,
    reason: RATIONALE_TEXT[hit.rationaleCode] ?? hit.rationaleCode,
    surface: strategySurface(hit.strategy),
    estimatedLatencyMs: ESTIMATED_LATENCY_MS[hit.strategy],
  };
}

interface RuleHit {
  strategy: OrchestrationStrategy;
  confidence: number;
  rationaleCode: string;
}

function hitOf(strategy: OrchestrationStrategy, code: string): RuleHit {
  return {
    strategy,
    confidence: RATIONALE_CONFIDENCE[code],
    rationaleCode: code,
  };
}

/** Rules 1–12 of the DECISION TABLE above, in documented order. */
function baseRule(text: string, o: OrchestrationPolicyOpts): RuleHit {
  const risk = o.risk;
  const highRisk = risk === 'high' || risk === 'critical';
  // 1 — the ONLY council trigger: design wording + explicit ambiguity marker.
  if (DESIGN_RE.test(text) && AMBIGUOUS_RE.test(text)) {
    return hitOf('council', 'design_conflict_signal');
  }
  // 2–3 — graph-level care: declared high risk or cross-cutting phrases.
  if (highRisk) return hitOf('graph', 'contract_high_risk');
  if (CROSS_CUTTING_RE.test(text)) return hitOf('graph', 'cross_cutting_scope');
  // 4–5 — parallelism potential: counted artifacts or a multi-path scope.
  if (MULTI_ARTIFACT_RE.test(text)) return hitOf('parallel-build', 'multi_artifact_count');
  if ((o.scopePathsCount ?? 0) >= PARALLEL_SCOPE_PATHS) {
    return hitOf('parallel-build', 'multi_path_scope');
  }
  // 6 — ordinary build work ⇒ implement then verify.
  for (const { re, code } of HEAVY_SIGNALS) {
    if (re.test(text) && HEAVY_CODES.has(code)) return hitOf('lead+verify', code);
  }
  // 7–11 — light tiers, most-specific first.
  if (AMBIGUOUS_RE.test(text)) return hitOf('explore', 'ambiguous_task');
  if (READONLY_RE.test(text)) return hitOf('explore', 'read_only_request');
  if (QUESTION_RE.test(text)) return hitOf('lead-only', 'question_shaped_task');
  if (EXPLAIN_RE.test(text)) return hitOf('lead-only', 'explanation_request');
  const budget = o.maxSoloChars ?? DEFAULT_MAX_SOLO_CHARS;
  // Tuning knob mirrors facts.collectOrchestrationFacts' bounded walk; kept
  // local so this module stays a pure leaf (facts must not be imported here).
  const largeRepo = (o.repoSize ?? 0) > 800;
  if (
    text.length <= budget &&
    (o.scopePathsCount ?? 0) <= 1 &&
    (o.previousFailures ?? 0) === 0 &&
    !highRisk &&
    !largeRepo
  ) {
    return hitOf('lead-only', 'small_task_no_heavy_signals');
  }
  // 12 — long neutral prompts stay on the historical default (fail-closed).
  return hitOf('lead-only', 'fail_closed_default');
}

/** Shared reason resolution for hosts/logs/tests. */
export function orchestrationReason(decision: Pick<OrchestrationDecision, 'rationaleCode'>): string {
  return RATIONALE_TEXT[decision.rationaleCode] ?? decision.rationaleCode;
}
