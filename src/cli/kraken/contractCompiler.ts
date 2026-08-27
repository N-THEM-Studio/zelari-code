/**
 * contractCompiler — t22 (§P1.C × PW §8): the TaskContract is no longer
 * descriptive prose; it COMPILES into the harness:
 *
 *   1. scope{allowedPaths,forbiddenPaths} → a RESTRICT-ONLY capability layer
 *      that joins the policy evaluation as a non-overridable third source.
 *      Because every effect goes through the shared lattice (deny > ask >
 *      allow), a compiled `deny` always applies and a compiled `allow` can
 *      NEVER relax the global/project/category decisions — the compiler can
 *      only narrow what the user already allows, never widen it.
 *   2. verificationHint commands → deterministic Criteria that join the SAME
 *      CompletionPolicy evaluation as the native criteria pack (blockers add
 *      up) — a failing "Verify:" command is REPAIR_REQUIRED, not narrative.
 *
 * The active-scope seam mirrors completionProofPersist.setActiveProof
 * PersistenceSurface (t20): hosts register the CURRENT versioned contract at
 * turn start / after each accepted steer; consumers read it here.
 */
import type { ShellProvider } from '@zelari/core/runtime';
import { LocalWorkspace, NodeShellProvider } from '@zelari/core/runtime';
import type { SessionEventInput } from '@zelari/core/session';
import type { TaskContract } from '@zelari/core';
import {
  VerificationEngine,
  type Criterion,
  type VerificationResult,
} from '@zelari/core/verification';
import type { ToolPermission } from '@zelari/core/harness/tools/toolTypes';
import {
  EMPTY_POLICY_RULE_SET,
  matchAgentPolicyRule,
  type PolicyRule,
  type PolicyRuleSet,
} from '../safety/policyEngine.js';

/** Engine packId for contract-derived checks (distinct from the coding pack). */
export const CONTRACT_CRITERIA_PACK_ID = 'task-contract/v1';

/** Per-command timeout for compiled criteria (mirrors the native pack default). */
export const CONTRACT_COMMAND_TIMEOUT_MS = 600_000;

/** Sanity cap for a hint accepted as one shell command line. */
const MAX_COMMAND_LENGTH = 512;

// ── Capability layer (scope → policy rules) ───────────────────────────────

/**
 * Compile `scope` into edit-category PolicyRules (the ACTUAL policyEngine
 * shape: ordered list, FIRST match wins within the layer). Order encodes
 * precedence so overlaps stay conservative:
 *
 *   forbidden denies → allowedPath allows → catch-all deny (`**`)
 *
 * RESTRICT-ONLY by construction: `deny` entries rank highest in
 * intersectEffects; the `allow` entries exist ONLY to opt paths out of the
 * trailing deny-all — ranked lowest they can never relax any other layer or
 * the category decision (identical lattice to policyLayers.ts).
 */
export function compileCapabilityRules(contract: TaskContract): PolicyRule[] {
  const scope = contract.scope;
  if (!scope) return [];
  const rules: PolicyRule[] = [];
  for (const glob of scope.forbiddenPaths ?? []) {
    if (glob.trim() === '') continue;
    rules.push({ match: glob, effect: 'deny', reason: 'contract:forbiddenPath' });
  }
  const allowed = (scope.allowedPaths ?? []).filter((g) => g.trim() !== '');
  if (allowed.length > 0) {
    for (const glob of allowed) {
      rules.push({ match: glob, effect: 'allow', reason: 'contract:allowedPath' });
    }
    rules.push({ match: '**', effect: 'deny', reason: 'contract:outsideAllowedPaths' });
  }
  return rules;
}

/**
 * The compiled layer as a `PolicyRuleSet` (edit-only) so callers can feed it
 * through the SAME evaluators used for global/project layers
 * (matchAgentPolicyRule / matchAgentPolicyRuleLayered): drop it in as an
 * extra source and the deny>ask>allow intersection does the rest.
 */
export function contractCapabilityLayer(contract: TaskContract): PolicyRuleSet {
  return { shell: [], edit: compileCapabilityRules(contract) };
}

// ── Active-scope seam (mirror t20 registration pattern) ───────────────────

export interface ActiveContractScope {
  /** The CURRENT contract object (version bumped by every accepted steer). */
  contract: TaskContract;
  /** Pre-compiled restrict-only capability layer (edit rules only). */
  capabilityRules: PolicyRuleSet;
}

let activeScope: ActiveContractScope | undefined;

/**
 * Register the live contract of THIS mission/turn (call at turn start and
 * again after every accepted steer — `latestTaskContract` + the spine carry
 * the new version). Pass `undefined` to clear. No-op-safe, idempotent.
 */
export function setActiveContractScope(contract: TaskContract | undefined): void {
  activeScope = contract ? { contract, capabilityRules: contractCapabilityLayer(contract) } : undefined;
}

/** Current registration (undefined when the turn has no scoped contract). */
export function activeContractScope(): ActiveContractScope | undefined {
  return activeScope;
}

/**
 * One tool invocation's CONTRACT verdict: restrict-only match of the active
 * capability layer over the invocation args (same path normalization /
 * candidates as the global+project layers). Null ⇒ the decision chain is
 * untouched; non-null ⇒ intersect its effect LAST (non-overridable slot).
 */
export function matchContractCapabilityRule(
  required: readonly ToolPermission[],
  args: unknown,
  root?: string,
): PolicyRule | null {
  return matchAgentPolicyRule(activeScope?.capabilityRules ?? EMPTY_POLICY_RULE_SET, required, args, root);
}

// ── Verification criteria (verificationHint → deterministic checks) ───────

/** True when value parses as ONE sane shell command line (no CR/LF/NUL). */
function isShellCommandLike(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_COMMAND_LENGTH) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\r\n\0]/.test(trimmed);
}

/**
 * Deterministic criteria from `verificationHint` commands: one Criterion per
 * acceptance criterion whose hint parses as a shell command (`Verify:`-style
 * lines). Required:true per user intent — these ARE the definition of done
 * stated by the author. `unknown ≠ pass` still holds end-to-end (an
 * unrunnable command honestly surfaces as unknown, blocking like the pack's).
 * No hints ⇒ [] ⇒ zero contribution (no behavior change for old contracts).
 */
export function compileVerificationCriteria(
  contract: TaskContract,
  opts: { timeoutMs?: number } = {},
): Criterion[] {
  const timeoutMs = opts.timeoutMs ?? CONTRACT_COMMAND_TIMEOUT_MS;
  const out: Criterion[] = [];
  for (const c of contract.acceptanceCriteria) {
    const hint = c.verificationHint;
    if (!hint || hint.kind !== 'command') continue;
    const command = hint.value?.trim();
    if (!command || !isShellCommandLike(command)) continue;
    out.push({
      id: `contract:${c.id}`,
      text: c.text,
      source: 'task',
      required: true,
      check: { kind: 'command', command, timeoutMs },
    });
  }
  return out;
}

/** Brief-named alias — the seam callers use when they hold the contract. */
export function contractCriteriaFor(contract: TaskContract, opts: { timeoutMs?: number } = {}): Criterion[] {
  return compileVerificationCriteria(contract, opts);
}

/**
 * Compiled criteria straight off the ACTIVE seam — how verificationBridge
 * pulls the current-turn contribution without threading options through
 * every host. Empty array when nothing is registered.
 */
export function activeContractCriteria(opts: { timeoutMs?: number } = {}): Criterion[] {
  return activeScope ? compileVerificationCriteria(activeScope.contract, opts) : [];
}

// ── Evaluation (same engine discipline as the native pack) ────────────────

export interface ContractCriteriaEvaluation {
  criteria: Criterion[];
  results: VerificationResult[];
}

export interface EvaluateContractCriteriaDeps {
  /** Workspace root used as command cwd. Defaults to process.cwd(). */
  cwd?: string;
  /** Shell seam (tests inject a stub); defaults to the core NodeShellProvider. */
  shell?: ShellProvider;
  /** Spine emitter — evidence events anchor exactly like the pack's (F3). */
  emit?: (input: SessionEventInput) => Promise<unknown>;
  /** Per-command timeout override. */
  timeoutMs?: number;
}

/**
 * Execute the contract's compiled criteria through the SAME deterministic
 * core engine the native pack uses. Deliberately NOT gated on
 * ZELARI_VERIFY_PACK (user-stated Verify commands stand alone); results join
 * the pack's inside evaluateStrictBuildGate where blockers add up.
 */
export async function evaluateContractCriteria(
  contract: TaskContract | undefined,
  deps: EvaluateContractCriteriaDeps = {},
): Promise<ContractCriteriaEvaluation | null> {
  if (!contract) return null;
  const cwd = deps.cwd ?? process.cwd();
  const criteria = compileVerificationCriteria(contract, { timeoutMs: deps.timeoutMs });
  if (criteria.length === 0) return null;
  const shell = deps.shell ?? new NodeShellProvider(new LocalWorkspace(cwd));
  const engine = deps.emit
    ? new VerificationEngine({ shell }, { emit: deps.emit })
    : new VerificationEngine({ shell });
  const results = await engine.evaluate(criteria, { packId: CONTRACT_CRITERIA_PACK_ID });
  return { criteria, results };
}
