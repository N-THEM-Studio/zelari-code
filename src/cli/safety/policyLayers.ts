/**
 * Policy LAYERS (P0.A) — combination semantics for layered agent policies.
 *
 * Split out of policyEngine.ts to keep both files small. This module owns
 * the RESTRICT-ONLY half of the evaluator: each layer (global, project)
 * matches independently against a tool invocation, and matched effects
 * intersect most-restrictive-wins:
 *
 *      deny > ask > allow        (see intersectEffects)
 *
 * Guarantees: a global deny can NEVER be relaxed to ask/allow by the
 * project file; a global ask can never degrade to allow; and whatever comes
 * out only ever ADDS restriction to the category decision (which itself
 * goes through mergeRuleEffect, same lattice). Legacy precedence
 * (ZELARI_POLICY_PRECEDENCE=legacy) changes WHICH rule surfaces (project
 * first, first-match-wins), not the fact that the survivor still merges
 * restrict-only into the category decision.
 *
 * @since v2.13.0
 */
import type { PermissionAction } from './toolPermissions.js';
import type { ToolPermission } from '@zelari/core/harness/tools/toolTypes';
import {
  EFFECT_RANK,
  matchAgentPolicyRule,
  type LayeredPolicyRuleSet,
  type PolicyPrecedence,
  type PolicyRule,
} from './policyEngine.js';

/**
 * Intersect candidate effects into ONE effect: deny > ask > allow. Absent
 * matches arrive as `undefined` and simply do not constrain the result; with
 * NO constraint at all the slot is unconstrained (`allow`). Feed this the
 * category decision plus every layer's matched effect and the result is the
 * effective action — no operand can ever RELAX another.
 */
export function intersectEffects(...effects: Array<PermissionAction | undefined>): PermissionAction {
  let best: PermissionAction | undefined;
  for (const effect of effects) {
    if (effect === undefined) continue;
    if (best === undefined || EFFECT_RANK[effect] > EFFECT_RANK[best]) best = effect;
  }
  return best ?? 'allow';
}

/**
 * Resolve THIS agent's policy contribution across BOTH layers for one tool
 * invocation:
 *
 * - `restrict-only` (default): each layer matches independently and the
 *   STRICTER effect wins; equal ranks surface the project rule (it is the
 *   more specific intent).
 * - `legacy`: v1 semantics — project rules concatenated before global ones,
 *   FIRST match wins (a project match masks the global rule entirely).
 *
 * Either way a single rule carries the effect the caller must intersect into
 * the category decision (see intersectEffects and wrapWithPermissions in
 * toolRegistry.ts). Tools with no usable argument match nothing in both
 * layers → null, leaving the category decision untouched.
 */
export function matchAgentPolicyRuleLayered(
  layers: LayeredPolicyRuleSet | undefined,
  precedence: PolicyPrecedence,
  required: readonly ToolPermission[],
  args: unknown,
  root?: string,
): PolicyRule | null {
  if (!layers) return null;
  if (precedence === 'legacy') {
    // v1: ONE concatenated list — project rules first, first-match-wins.
    return matchAgentPolicyRule(
      {
        shell: [...layers.project.shell, ...layers.global.shell],
        edit: [...layers.project.edit, ...layers.global.edit],
      },
      required,
      args,
      root,
    );
  }
  // Default restrict-only: independent matches, stricter effect wins (ties
  // keep the project rule as the surfaced representative).
  const g = matchAgentPolicyRule(layers.global, required, args, root);
  const p = matchAgentPolicyRule(layers.project, required, args, root);
  if (!g) return p;
  if (!p) return g;
  const win = intersectEffects(p.effect, g.effect);
  return p.effect === win ? p : g;
}
