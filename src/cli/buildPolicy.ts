/**
 * buildPolicy — experiment: multi-agent plans, single-agent builds.
 *
 * On branch `experiment/plan-multiagent-build-agent`:
 *   - Zelari implementation slices default to the single-agent harness.
 *   - Council design-phase is unchanged (planning / artifacts in `.zelari/`).
 *   - Council+build is soft-gated unless ZELARI_COUNCIL_CAN_BUILD=1.
 *
 * Escape hatches (power users / A-B):
 *   ZELARI_BUILD_VIA_AGENT=0     → zelari impl uses full council again
 *   ZELARI_COUNCIL_CAN_BUILD=1   → allow Lucifero to implement (also forces
 *                                   zelari impl onto the council path)
 *
 * Pure module — unit-testable without LLM or TUI.
 */

export interface BuildPolicyEnv {
  ZELARI_BUILD_VIA_AGENT?: string;
  ZELARI_COUNCIL_CAN_BUILD?: string;
  ZELARI_MODE_MAX_TOOLS_AGENT?: string;
}

const DEFAULT_AGENT_TOOL_BUDGET = 40;

/**
 * When true, Zelari mission **implementation** slices run via single-agent
 * harness instead of council (Lucifero). Design-phase always stays council.
 *
 * Experiment default: ON (opt-out with `ZELARI_BUILD_VIA_AGENT=0`).
 * `ZELARI_COUNCIL_CAN_BUILD=1` wins and forces legacy council implementer.
 */
export function shouldBuildViaAgent(
  env: BuildPolicyEnv = process.env,
): boolean {
  if (shouldAllowCouncilBuild(env)) return false;
  // Explicit off
  if (env.ZELARI_BUILD_VIA_AGENT === '0') return false;
  // Explicit on or unset (experiment default ON)
  return true;
}

/**
 * When true, council mode may run implementation (Lucifero writes project files).
 * Default false on this experiment branch.
 */
export function shouldAllowCouncilBuild(
  env: BuildPolicyEnv = process.env,
): boolean {
  return env.ZELARI_COUNCIL_CAN_BUILD === '1';
}

/** Tool-call budget for agent implementation slices inside a Zelari mission. */
export function resolveAgentMissionToolBudget(
  env: BuildPolicyEnv = process.env,
): number {
  const raw = env.ZELARI_MODE_MAX_TOOLS_AGENT;
  if (raw === undefined || raw === '') return DEFAULT_AGENT_TOOL_BUDGET;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_AGENT_TOOL_BUDGET;
}

/** Short human summary for logs / `/mode` feedback / system banners. */
export function describeBuildPolicy(
  env: BuildPolicyEnv = process.env,
): string {
  const viaAgent = shouldBuildViaAgent(env);
  const councilBuild = shouldAllowCouncilBuild(env);
  const parts = [
    viaAgent
      ? 'zelari build@kraken (default)'
      : 'zelari build@council (legacy)',
    councilBuild
      ? 'council may implement'
      : 'council plan-only unless ZELARI_COUNCIL_CAN_BUILD=1',
  ];
  return parts.join(' · ');
}
