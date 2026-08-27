/**
 * orchestration/signals — t23 (§P1.E × PW §9): shared vocabulary + signal
 * tables for the deterministic OrchestrationDecision v2.
 *
 * LEAF MODULE on purpose: it imports nothing (not even other cli files) so
 * both orchestration/policy.ts and kraken/delegationPolicy.ts can consume the
 * strategy union without creating an import cycle. Pure data + pure fns only.
 *
 * Strategy ladder (escalation order — see policy.ts decision table):
 *   lead-only      one focused dev, no tentacles.
 *   explore        read/search-oriented work, still single harness.
 *   lead+verify    implement + mandatory verify pass.
 *   parallel-build multiple disjoint slices → tentacles preferred.
 *   graph          high risk / cross-cutting → plan-graph level care.
 *   council        ONLY with the design-conflict trigger (never invented).
 */

/** Fine-grained v2 strategies (supersedes the v1 two-value surface only —
 * `surface` remains for operator logs and back-compat). */
export const ORCHESTRATION_STRATEGIES = [
  'lead-only',
  'explore',
  'lead+verify',
  'parallel-build',
  'graph',
  'council',
] as const;

export type OrchestrationStrategy = (typeof ORCHESTRATION_STRATEGIES)[number];

/** Dispatch surfaces available in headless (v1 union + council). */
export type OrchestrationSurface = 'solo' | 'kraken' | 'council';

/** Monotonic complexity rank: a failure/risk bump may raise but never lower. */
export const STRATEGY_RANK: Readonly<Record<OrchestrationStrategy, number>> = {
  'lead-only': 0,
  explore: 1,
  'lead+verify': 2,
  'parallel-build': 3,
  graph: 4,
  council: 5,
};

/**
 * estimatedLatency heuristic (UNIT: milliseconds, ORDER-OF-MAGNITUDE ONLY —
 * NOT a prediction): rough cost of a typical single-turn run per strategy,
 * measured-in-the-head at authoring time and kept monotonic with
 * STRATEGY_RANK. Used by telemetry dashboards and tests to compare relative
 * orchestration weight, never to promise wall-clock behavior.
 */
export const ESTIMATED_LATENCY_MS: Readonly<Record<OrchestrationStrategy, number>> = {
  'lead-only': 15_000,
  explore: 45_000,
  'lead+verify': 120_000,
  'parallel-build': 360_000,
  graph: 720_000,
  council: 900_000,
};

/** strategy → headless dispatch surface (mode-selection input). */
export function strategySurface(strategy: OrchestrationStrategy): OrchestrationSurface {
  if (strategy === 'council') return 'council';
  if (STRATEGY_RANK[strategy] >= STRATEGY_RANK['lead+verify']) return 'kraken';
  return 'solo';
}

/**
 * Heavy-intent signals (t12 table carried over verbatim, now tagged with a
 * stable rationaleCode). Evaluated FIRST: heavy intent outranks any light
 * signal below.
 */
export const HEAVY_SIGNALS: ReadonlyArray<{ re: RegExp; code: string }> = [
  { re: /\bimplement(?:s|ed|ing)?\b/i, code: 'implementation_signal' },
  { re: /\brefactor(?:ing|ed)?\b/i, code: 'refactor_signal' },
  { re: /\bmigrat(?:e|es|ed|ion|ing)\b/i, code: 'migration_signal' },
  {
    re: /\b(?:add|build|create|introduce)\b[^.?!]{0,48}\b(?:feature|endpoint|module|service|command|api|registry|runtime)\b/i,
    code: 'new_capability_signal',
  },
  {
    re: /\b(?:unit|integration|e2e|end-to-end)\s+(?:tests?|testing|specs?)\b|\bwrite\s+(?:the\s+|some\s+)?tests?\b/i,
    code: 'test_writing_signal',
  },
];

/**
 * Counted artifacts ("Split the helpers into 4 files") — evidence of several
 * DISJOINT targets, i.e. parallelism potential (rank ≥ parallel-build).
 */
export const MULTI_ARTIFACT_RE =
  /\b\d+\s*-?\s*(?:files?|modules?|packages?|components?|services?|endpoints?|worktrees?)\b/i;

/** Cross-cutting scope phrases → graph-level care regardless of verb. */
export const CROSS_CUTTING_RE =
  /\b(?:across|spanning|between|touching)\s+(?:all\s+|the\s+)?(?:\w+\s+){0,2}(?:files|modules|packages|layers|surfaces)\b/i;

/** Question-shaped prompt: trailing '?' or a leading interrogative/modal. */
export const QUESTION_RE =
  /\?\s*$|^(?:who|what|why|when|where|which|how|is|are|was|were|does|do|did|can|could|should|would|will)\b/i;

export const EXPLAIN_RE = /\b(?:explain|describe|summarize|summarise|clarify|walk\W*me\W*through)\b/i;

export const READONLY_RE = /\b(?:find|show|list|grep|search|locate|inspect|read|check|review|where\W+is)\b/i;

/** Ambiguity markers: task asks for judgment on unclear/conflicting ground. */
export const AMBIGUOUS_RE =
  /\b(?:ambiguous|ambiguity|unclear|vague|contradict(?:ory|ions?)?|conflicts?\b|trade[- ]?offs?\b|not\s+sure|unsure)\b/i;

/**
 * Design-intent nouns for the (ONLY) council trigger: "plan/design/architect"
 * wording CO-OCCURRING with ambiguity markers above ⇒ multi-member review.
 * Both halves required — neither alone ever selects council.
 */
export const DESIGN_RE = /\b(?:design|architecture|architect(?:ure)?\b|approach|proposal|blueprint)/i;
