import type { SystemPromptModule } from '@zelari/core/skills';
import type { OrchestrationStrategy } from '../orchestration/signals.js';

/**
 * Kraken Delegation Policy — when the lead should spawn tentacles.
 *
 * Routing (`ZELARI_KRAKEN_*_MODEL`) answers *which model* a tentacle uses.
 * This policy answers *whether* the lead should create the tentacle at all.
 *
 * `automatic` (default) injects nothing. Two sources can produce a REAL
 * policy now (t23 / P1.E):
 *   1. this env var (explicit user/host override — WINS below),
 *   2. a strategy-derived mapping from the v2 OrchestrationDecision:
 *      `resolveDelegationPolicyForRun(strategy)` in the `--mode auto` path
 *      replaces the historical no-op injection with an actual module.
 *
 * Env: `ZELARI_KRAKEN_DELEGATION=automatic|prefer|aggressive|lead-only`
 */
export const KRAKEN_DELEGATION_ENV = 'ZELARI_KRAKEN_DELEGATION';

export const DELEGATION_POLICIES = [
  'automatic',
  'prefer',
  'aggressive',
  'lead-only',
] as const;

export type DelegationPolicy = (typeof DELEGATION_POLICIES)[number];

const ALIASES: Record<string, DelegationPolicy> = {
  automatic: 'automatic',
  auto: 'automatic',
  default: 'automatic',
  prefer: 'prefer',
  'prefer-tentacles': 'prefer',
  tentacles: 'prefer',
  aggressive: 'aggressive',
  always: 'aggressive',
  'lead-only': 'lead-only',
  lead_only: 'lead-only',
  leadonly: 'lead-only',
  off: 'lead-only',
};

export function isDelegationPolicy(value: unknown): value is DelegationPolicy {
  return (
    typeof value === 'string' &&
    (DELEGATION_POLICIES as readonly string[]).includes(value)
  );
}

export function resolveDelegationPolicy(
  raw: string | undefined = process.env[KRAKEN_DELEGATION_ENV],
): DelegationPolicy {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return 'automatic';
  return ALIASES[v] ?? 'automatic';
}

/**
 * t23 (§P1.E) — strategy → delegation mapping (replaces the `automatic`
 * no-op when a v2 OrchestrationDecision is present). Maps onto the EXISTING
 * three policy fragments (no new prompt prose invented):
 *
 *   lead-only      → 'lead-only'  (prefer-lead / no tentacles)
 *   explore        → 'automatic'  (solo surface: delegation n/a, neutral)
 *   lead+verify    → 'prefer'     (default WITH the verify pass)
 *   parallel-build → 'prefer'     (tentacles preferred incl. general)
 *   graph          → 'prefer'     (tentacles preferred incl. general)
 *   council        → null         (n/a on the council surface)
 */
export const STRATEGY_DELEGATION: Readonly<
  Record<OrchestrationStrategy, DelegationPolicy | null>
> = {
  'lead-only': 'lead-only',
  explore: 'automatic',
  'lead+verify': 'prefer',
  'parallel-build': 'prefer',
  graph: 'prefer',
  council: null,
};

/**
 * Effective delegation policy for one run. PRECEDENCE: an explicit
 * non-automatic `ZELARI_KRAKEN_DELEGATION` wins over any strategy-derived
 * value; otherwise the strategy map applies; no strategy ⇒ historical
 * default ('automatic', which still injects nothing).
 */
export function resolveDelegationPolicyForRun(
  strategy?: OrchestrationStrategy,
  env: NodeJS.ProcessEnv = process.env,
): DelegationPolicy {
  const raw = env[KRAKEN_DELEGATION_ENV]?.trim().toLowerCase() ?? '';
  const explicit = raw ? ALIASES[raw] : undefined;
  if (explicit && explicit !== 'automatic') return explicit;
  const derived = strategy ? STRATEGY_DELEGATION[strategy] : undefined;
  return derived ?? 'automatic';
}

const PREFER_CONTENT = `# Kraken Delegation Policy

Current policy: **prefer tentacles**.

You are still the parent brain, but default to the \`task\` tool for non-trivial work instead of doing the whole job yourself.

- **explore** — unfamiliar area, multi-file search, map call sites (parallel OK).
- **general** — isolated implement slice with a clear path scope.
- **verify** — after meaningful writes, spawn verify (or run tests yourself).
- Lead-direct tools are OK for: one-file trivial reads, \`todo_write\`, \`ask_user\`, and the final synthesis.
- Do not skip tentacles just because you *can* grep/edit yourself. If you skip, say why in one line.
- Keep the existing caps (≤4 explore, ≤2 general per turn) and task-contract quality.
`;

const AGGRESSIVE_CONTENT = `# Kraken Delegation Policy

Current policy: **aggressive**.

You are an orchestrator, not an implementer. DEFAULT to spawning tentacles.

- Almost every research question → \`task(agent=explore)\`.
- Almost every code change → \`task(agent=general)\`, then \`task(agent=verify)\`.
- Lead may use tools only for: \`todo_write\`, \`ask_user\`, reading tentacle results, and the final summary.
- Do not implement or explore the repo yourself unless the user explicitly asked for lead-only, or the change is a one-line typo you can verify immediately.
- Still respect task contracts (Goal / Scope / Acceptance / Constraints) and spawn caps.
`;

const LEAD_ONLY_CONTENT = `# Kraken Delegation Policy

Current policy: **lead only**.

- Do **not** spawn \`task\` tentacles (explore / general / verify) unless the user explicitly asks.
- Do the work yourself with \`read_file\` / \`grep_content\` / \`bash\` / \`edit\`.
- The \`task\` tool remains available for an explicit user request only.
`;

const FRAGMENTS: Record<Exclude<DelegationPolicy, 'automatic'>, string> = {
  prefer: PREFER_CONTENT,
  aggressive: AGGRESSIVE_CONTENT,
  'lead-only': LEAD_ONLY_CONTENT,
};

/**
 * Returns the delegation override module, or [] when `include` is false
 * or the policy is `automatic` (prompt stays byte-identical).
 */
export function krakenDelegationPlaybook(
  include: boolean,
  policy: DelegationPolicy = resolveDelegationPolicy(),
): SystemPromptModule[] {
  if (!include || policy === 'automatic') return [];
  return [
    {
      type: 'custom',
      title: 'Kraken Delegation Policy',
      // After KRAKEN_LEAD_PLAYBOOK_MODULE (25). Custom modules get +1000
      // in the builder, so this still sorts with the other Kraken extras.
      priority: 26,
      content: FRAGMENTS[policy],
    },
  ];
}

export function delegationPolicyLabel(policy: DelegationPolicy): string {
  switch (policy) {
    case 'prefer':
      return 'Prefer tentacles';
    case 'aggressive':
      return 'Aggressive';
    case 'lead-only':
      return 'Lead only';
    default:
      return 'Automatic';
  }
}
