/**
 * Policy engine v2 (P0.A) — per-command and per-path permission rules per
 * agent, layered on top of the per-CATEGORY policy in toolPermissions.ts.
 *
 * Rules come from two USER-authored config files (same trust level as
 * AGENTS.MD — deliberately NO trust subsystem here; the GLOBAL file is the
 * user's personal floor, which the project file can NO LONGER relax):
 *
 *   <root>/.zelari/policy.json   — project rules
 *   ~/.zelari/policy.json        — global rules
 *
 * Shape:
 *   {
 *     version?: 1,
 *     agents: {
 *       lead?    : { shell?: Rule[], edit?: Rule[] },
 *       explore? : { shell?: Rule[], edit?: Rule[] },
 *       general? : { shell?: Rule[], edit?: Rule[] },
 *       verify?  : { shell?: Rule[], edit?: Rule[] }
 *     }
 *   }
 *   Rule = { match: string, effect: 'allow' | 'ask' | 'deny', reason?: string }
 *
 * `match` is a GLOB-style prefix pattern: `git push*` matches any command
 * starting with "git push"; `src/**` matches any path under src/; `*` alone
 * matches everything. Within one LAYER's ordered rule list the FIRST match
 * wins (P0.A): the two layers stay SEPARATE and combine RESTRICT-ONLY — every
 * matching rule intersects with the category decision, most-restrictive-wins
 * (deny > ask > allow), so a global deny can never be masked by the project.
 * Escape hatch: ZELARI_POLICY_PRECEDENCE=legacy restores the v1 behavior
 * (project rules concatenated before global ones, first-match overrides);
 * the active mode is exposed as `PolicySet.precedence`.
 *
 * Fail-closed conventions (mirrors toolPermissions.ts): a missing file is
 * silently empty; a broken file NEVER throws — the parse error is collected
 * in `warnings` and the offending file/section is ignored. Opt out entirely
 * with ZELARI_POLICY=0 (always the empty set).
 *
 * Hand-rolled validators on purpose: no zod, no new deps.
 *
 * @since v2.12.0 · restrict-only layers v2.13.0
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { PermissionAction } from './toolPermissions.js';
import type { ToolPermission } from '@zelari/core/harness/tools/toolTypes';

/** Rule effect reuses the category lattice: allow | ask | deny. */
export type PolicyEffect = PermissionAction;

export interface PolicyRule {
  /** GLOB-style prefix pattern (`*` and `**` wildcards). */
  match: string;
  effect: PolicyEffect;
  /** Human-readable explanation surfaced in deny/ask messages. */
  reason?: string;
}

/**
 * How the global and project LAYERS combine (P0.A): `restrict-only` (the
 * default) matches each layer independently and keeps the MOST restrictive
 * effect (deny > ask > allow); `legacy` restores v1 semantics — project
 * rules before global ones in one first-match-wins list.
 */
export type PolicyPrecedence = 'restrict-only' | 'legacy';

/** One agent's ordered rule lists. First match wins within each list. */
export interface PolicyRuleSet {
  /** Matched against the shell command string (execute-category tools). */
  shell: PolicyRule[];
  /** Matched against the primary path argument (write-category tools). */
  edit: PolicyRule[];
}

/** Per-agent rules kept as DISTINCT sources (never concatenated upstream). */
export interface LayeredPolicyRuleSet {
  /** `~/.zelari/policy.json` rules — the user-level floor. */
  global: PolicyRuleSet;
  /** `<root>/.zelari/policy.json` rules — repo-level refinement. */
  project: PolicyRuleSet;
}

export interface PolicySet {
  /** Agent key → layered rule sets (global + project kept distinct). */
  agents: Map<string, LayeredPolicyRuleSet>;
  /** Non-fatal problems: invalid JSON, unknown agents, skipped rules. */
  warnings: string[];
  /** Which precedence resolved this set (read once at load time). */
  precedence: PolicyPrecedence;
}

/** The authoritative agent keys ('lead' = the main registry; the three
 * sub-agent kinds mirror taskAgentToProfile in toolRegistry.ts). */
export const POLICY_AGENTS: readonly string[] = ['lead', 'explore', 'general', 'verify'];
const KNOWN_AGENTS: ReadonlySet<string> = new Set(POLICY_AGENTS);

export const EMPTY_POLICY_RULE_SET: PolicyRuleSet = { shell: [], edit: [] };
export const EMPTY_POLICY_LAYERS: LayeredPolicyRuleSet = {
  global: EMPTY_POLICY_RULE_SET,
  project: EMPTY_POLICY_RULE_SET,
};

export function emptyPolicySet(): PolicySet {
  return { agents: new Map(), warnings: [], precedence: policyPrecedenceFromEnv() };
}

/** Raw layers for one agent; unknown/unlisted agents get the empty layers. */
export function agentLayersFor(set: PolicySet, agent: string): LayeredPolicyRuleSet {
  return set.agents.get(agent) ?? EMPTY_POLICY_LAYERS;
}

/**
 * COMPAT view (v1 shape): project rules then global rules in ONE list —
 * first-match over this concatenation IS legacy precedence. Restrict-only
 * consumers must use agentLayersFor + matchAgentPolicyRuleLayered instead.
 */
export function agentRulesFor(set: PolicySet, agent: string): PolicyRuleSet {
  const l = set.agents.get(agent);
  if (!l) return EMPTY_POLICY_RULE_SET;
  return {
    shell: [...l.project.shell, ...l.global.shell],
    edit: [...l.project.edit, ...l.global.edit],
  };
}

// ── Glob matching ──────────────────────────────────────────────────────────

/**
 * Compile a GLOB-style pattern into an ANCHORED RegExp (full match).
 *
 * Wildcard semantics: `*` and `**` are both "any characters, including path
 * separators" — these are prefix patterns, not full minimatch; `src/**`
 * means "anything under src/", `git push*` means "starts with git push",
 * and a bare `*` is the catch-all. Consecutive stars collapse to one `.*`.
 * Every other character is regex-escaped (`data.json` matches literally).
 */
export function globToRegExp(pattern: string): RegExp {
  let src = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      while (pattern[i + 1] === '*') i++;
      src += '.*';
    } else if ('\\^$.|?+()[]{}'.includes(ch)) {
      src += '\\' + ch;
    } else {
      src += ch;
    }
  }
  return new RegExp(src + '$');
}

/** Backslashes (Windows paths) normalize to `/` so `src/**` matches `src\x.ts`. */
function normalizeForMatch(value: string): string {
  return value.replace(/\\/g, '/');
}

/**
 * First match wins: return the FIRST rule whose pattern matches `value`,
 * or null when nothing matches (caller keeps its category decision).
 */
export function resolvePolicyRule(rules: readonly PolicyRule[], value: string): PolicyRule | null {
  const v = normalizeForMatch(value);
  for (const rule of rules) {
    if (globToRegExp(normalizeForMatch(rule.match)).test(v)) return rule;
  }
  return null;
}

// ── Merge with the category decision ──────────────────────────────────────

/** Shared lattice with policyLayers.ts intersectEffects: deny > ask > allow. */
export const EFFECT_RANK: Record<PolicyEffect, number> = { allow: 0, ask: 1, deny: 2 };

/**
 * Merge a matched rule's effect into the category-level action under the
 * same lattice as intersectPermissionPolicy: deny > ask > allow. A rule can
 * only ADD restriction — an `allow` rule never un-asks or un-denies a
 * category restriction (no privilege escalation via policy.json).
 */
export function mergeRuleEffect(base: PermissionAction, rule: PolicyRule | null): PermissionAction {
  if (!rule) return base;
  return EFFECT_RANK[rule.effect] > EFFECT_RANK[base] ? rule.effect : base;
}

/**
 * Path candidates to test against edit rules: the argument as passed, plus
 * the root-relative form when the arg lives under `root` (so `src/**` works
 * whether the model passed `src/x.ts` or `E:\repo\src\x.ts`). Root-relative
 * first — it is what users write in policy.json.
 */
function pathCandidates(value: string, root?: string): string[] {
  const norm = normalizeForMatch(value);
  if (!root) return [norm];
  const prefix = normalizeForMatch(root).replace(/\/+$/, '') + '/';
  const stripped = norm.toLowerCase().startsWith(prefix.toLowerCase())
    ? norm.slice(prefix.length)
    : null;
  return stripped !== null ? [stripped, norm] : [norm];
}

/**
 * Find the agent rule that applies to one tool invocation:
 * - execute-category tools (bash, inspect_command): shell rules vs the
 *   `command` string argument;
 * - write-category tools (write_file / edit_file / apply_diff): edit rules
 *   vs the primary path argument (`path`, falling back to `file_path`),
 *   tried root-relative first (see pathCandidates).
 * Tools without a usable argument (or no rules) match nothing → null.
 */
export function matchAgentPolicyRule(
  rules: PolicyRuleSet | undefined,
  required: readonly ToolPermission[],
  args: unknown,
  root?: string,
): PolicyRule | null {
  if (!rules) return null;
  const a = (args !== null && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  if (required.includes('execute')) {
    const cmd = a['command'];
    if (typeof cmd === 'string' && cmd !== '') {
      const hit = resolvePolicyRule(rules.shell, cmd);
      if (hit) return hit;
    }
  }
  if (required.includes('write')) {
    const p = typeof a['path'] === 'string' ? a['path'] : typeof a['file_path'] === 'string' ? a['file_path'] : '';
    if (p !== '') {
      for (const candidate of pathCandidates(p, root)) {
        const hit = resolvePolicyRule(rules.edit, candidate);
        if (hit) return hit;
      }
    }
  }
  return null;
}

// ── Loading & validation (fail-closed on files, never throws) ─────────────

/** Env opt-out: ZELARI_POLICY=0 (also false/no/off) → always the empty set. */
export function isPolicyEngineDisabled(): boolean {
  const v = process.env.ZELARI_POLICY?.trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'no' || v === 'off';
}

/**
 * P0.A escape hatch: ZELARI_POLICY_PRECEDENCE=legacy selects the v1
 * project-overrides-global first-match behavior; any other value (unset
 * included) selects the default restrict-only layering. Read at policy-load
 * time and exposed as PolicySet.precedence so callers/tests can assert the
 * active mode.
 */
export function policyPrecedenceFromEnv(): PolicyPrecedence {
  const v = process.env.ZELARI_POLICY_PRECEDENCE?.trim().toLowerCase();
  return v === 'legacy' ? 'legacy' : 'restrict-only';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseRuleList(raw: unknown, origin: string, warnings: string[]): PolicyRule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warnings.push(`${origin}: expected an array of rules, got ${typeof raw} — section ignored.`);
    return [];
  }
  const out: PolicyRule[] = [];
  raw.forEach((item, i) => {
    const where = `${origin}[${i}]`;
    if (!isPlainObject(item)) {
      warnings.push(`${where}: rule is not an object — skipped.`);
      return;
    }
    const match = item['match'];
    const effect = item['effect'];
    const reason = item['reason'];
    if (typeof match !== 'string' || match.trim() === '') {
      warnings.push(`${where}: missing or empty "match" — skipped.`);
      return;
    }
    if (effect !== 'allow' && effect !== 'ask' && effect !== 'deny') {
      warnings.push(`${where} ("${match}"): "effect" must be allow|ask|deny — skipped.`);
      return;
    }
    out.push(
      typeof reason === 'string' && reason.trim() !== '' ? { match, effect, reason } : { match, effect },
    );
  });
  return out;
}

/** Returns null when the WHOLE file must be ignored (bad shape / version). */
function parsePolicyFile(
  raw: unknown,
  origin: string,
  warnings: string[],
): Map<string, PolicyRuleSet> | null {
  if (!isPlainObject(raw)) {
    warnings.push(`${origin}: policy file is not a JSON object — file ignored.`);
    return null;
  }
  const version = raw['version'];
  if (version !== undefined && version !== 1) {
    warnings.push(`${origin}: unsupported "version" ${JSON.stringify(version)} (expected 1) — file ignored.`);
    return null;
  }
  const agentsRaw = raw['agents'];
  if (agentsRaw === undefined) {
    warnings.push(`${origin}: no "agents" key — file ignored.`);
    return null;
  }
  if (!isPlainObject(agentsRaw)) {
    warnings.push(`${origin}: "agents" is not an object — file ignored.`);
    return null;
  }
  const out = new Map<string, PolicyRuleSet>();
  for (const [key, val] of Object.entries(agentsRaw)) {
    const agent = key.trim().toLowerCase();
    if (!KNOWN_AGENTS.has(agent)) {
      warnings.push(`${origin}: unknown agent "${key}" (known: ${POLICY_AGENTS.join(' | ')}) — ignored.`);
      continue;
    }
    if (!isPlainObject(val)) {
      warnings.push(`${origin}: agents.${key} is not an object — ignored.`);
      continue;
    }
    const shell = parseRuleList(val['shell'], `${origin} agents.${key}.shell`, warnings);
    const edit = parseRuleList(val['edit'], `${origin} agents.${key}.edit`, warnings);
    out.set(agent, { shell, edit });
  }
  return out;
}

function readPolicyFile(file: string, warnings: string[]): Map<string, PolicyRuleSet> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // Missing file is the common case (most repos/users have none) — not a
    // warning, just no rules from this source.
    return new Map();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    warnings.push(
      `${file}: invalid JSON (${err instanceof Error ? err.message : String(err)}) — file ignored.`,
    );
    return new Map();
  }
  return parsePolicyFile(parsed, file, warnings) ?? new Map();
}

/**
 * Load the project (`<root>/.zelari/policy.json`) and global
 * (`~/.zelari/policy.json`) rule sets into DISTINCT layers (P0.A): the two
 * sources are NEVER concatenated at load time — evaluation intersects them
 * restrict-only (matchAgentPolicyRuleLayered in policyLayers.ts) unless
 * ZELARI_POLICY_PRECEDENCE=legacy restores the v1 concat view. NEVER
 * throws: broken files yield warnings + whatever parsed cleanly. Pass
 * `homeDir` to override the global-file location (tests).
 */
export function loadPolicySet(root: string, opts: { homeDir?: string } = {}): PolicySet {
  if (isPolicyEngineDisabled()) return emptyPolicySet();
  const warnings: string[] = [];
  const precedence = policyPrecedenceFromEnv();
  const project = readPolicyFile(path.join(root, '.zelari', 'policy.json'), warnings);
  const global = readPolicyFile(path.join(opts.homeDir ?? homedir(), '.zelari', 'policy.json'), warnings);
  const agents = new Map<string, LayeredPolicyRuleSet>();
  for (const [agent, p] of project) {
    agents.set(agent, { project: p, global: EMPTY_POLICY_RULE_SET });
  }
  for (const [agent, g] of global) {
    const l = agents.get(agent);
    agents.set(agent, l ? { ...l, global: g } : { project: EMPTY_POLICY_RULE_SET, global: g });
  }
  return { agents, warnings, precedence };
}
