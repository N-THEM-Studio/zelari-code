/**
 * orchestration/policy — pure task classifier for `--mode auto` (t12 / P1.1).
 *
 * Given a raw task prompt, decide which orchestration surface owns the run.
 * Deterministic and side-effect-free: no clock, no randomness, no I/O, no
 * environment reads — callers pass their flags/overrides in via `opts`.
 *
 * Tiers (first match wins):
 *   1. heavy intent   -> 'kraken'  implement/refactor/migrate, new capabilities,
 *                                  test-writing, counted artifacts, cross-cutting
 *   2. light intent   -> 'solo'    questions ("...?"), explain/describe,
 *                                  read-only requests (find/show/list/grep)
 *   3. size           -> 'solo'    short prompt without heavy intent
 *   4. default        -> 'solo'    fail-closed: unsure means "current behavior"
 *
 * Only surfaces that actually exist in runHeadless dispatch are produced
 * ('kraken' today rides the single-harness super-agent path; 'solo' is the
 * ordinary lightweight turn). No invented values here — council/zelari
 * remain explicit opt-ins, never auto-selected.
 */

/** Orchestration surfaces available in headless dispatch (do not extend lightly). */
export type OrchestrationSurface = 'solo' | 'kraken';

export interface OrchestrationPolicyOpts {
  /**
   * Max prompt size (trimmed chars) considered small enough for solo when no
   * signal matched. Default {@link DEFAULT_MAX_SOLO_CHARS}.
   */
  maxSoloChars?: number;
}

export interface OrchestrationVerdict {
  surface: OrchestrationSurface;
  /** Short stable explanation; safe to log verbatim. */
  reason: string;
}

/**
 * Prompts at or under this length with no heavy intent are treated as small.
 * Conservative on purpose: longer neutral prompts fall through to the same
 * 'solo' default, just with the fail-closed reason.
 */
export const DEFAULT_MAX_SOLO_CHARS = 300;

/** Heavy-intent signals — evaluated first so they outrank any light signal. */
const KRAKEN_SIGNALS: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /\bimplement(?:s|ed|ing)?\b/i, reason: 'implementation signal' },
  { re: /\brefactor(?:ing|ed)?\b/i, reason: 'refactor signal' },
  { re: /\bmigrat(?:e|es|ed|ion|ing)\b/i, reason: 'migration signal' },
  {
    re: /\b(?:add|build|create|introduce)\b[^.?!]{0,48}\b(?:feature|endpoint|module|service|command|api|registry|runtime)\b/i,
    reason: 'new-capability signal',
  },
  {
    re: /\b(?:unit|integration|e2e|end-to-end)\s+(?:tests?|testing|specs?)\b|\bwrite\s+(?:the\s+|some\s+)?tests?\b/i,
    reason: 'test-writing signal',
  },
  {
    re: /\b\d+\s*-?\s*(?:files?|modules?|packages?|components?|services?|endpoints?|worktrees?)\b/i,
    reason: 'multi-artifact count',
  },
  {
    re: /\b(?:across|spanning|between|touching)\s+(?:all\s+|the\s+)?(?:\w+\s+){0,2}(?:files|modules|packages|layers|surfaces)\b/i,
    reason: 'cross-cutting scope',
  },
];

/** Question-shaped prompt: trailing '?' or a leading interrogative/modal. */
const QUESTION_RE =
  /\?\s*$|^(?:who|what|why|when|where|which|how|is|are|was|were|does|do|did|can|could|should|would|will)\b/i;

const EXPLAIN_RE = /\b(?:explain|describe|summarize|summarise|clarify|walk\W*me\W*through)\b/i;

const READONLY_RE = /\b(?:find|show|list|grep|search|locate|inspect|read|check|review|where\W+is)\b/i;

/**
 * Classify a task prompt into an orchestration surface.
 *
 * Pure function: identical inputs always yield identical verdicts.
 * Fail-closed — when nothing matches, the answer is the CLI's historical
 * behavior ('solo'), never a speculative escalation.
 */
export function chooseOrchestration(
  task: string,
  opts: OrchestrationPolicyOpts = {},
): OrchestrationVerdict {
  const text = String(task ?? '').trim();

  const failClosed = (): OrchestrationVerdict => ({
    surface: 'solo',
    reason: 'fail-closed default',
  });

  if (!text) return failClosed();

  // Tier 1 — heavy intent wins over everything below.
  for (const { re, reason } of KRAKEN_SIGNALS) {
    if (re.test(text)) return { surface: 'kraken', reason };
  }

  // Tier 2 — light intent: questions, explanations, read-only asks.
  if (QUESTION_RE.test(text)) return { surface: 'solo', reason: 'question-shaped task' };
  if (EXPLAIN_RE.test(text)) return { surface: 'solo', reason: 'explanation request' };
  if (READONLY_RE.test(text)) return { surface: 'solo', reason: 'read-only request' };

  // Tier 3 — short and unremarkable: comfortably within the solo budget.
  const budget = opts.maxSoloChars ?? DEFAULT_MAX_SOLO_CHARS;
  if (text.length <= budget) {
    return { surface: 'solo', reason: 'small task, no heavy signals' };
  }

  // Tier 4 — unsure (long, no signals): stay on today's default path.
  return failClosed();
}
