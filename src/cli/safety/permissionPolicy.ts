/**
 * WS1 / t133 — permission policy engine (allow | ask | deny) for tool dispatch.
 *
 * A local, declarative rule layer evaluated BEFORE every CLI tool dispatch:
 *
 *   .zelari/permissions.json  (source 'project') ─┐
 *   /permissions add …        (source 'session') ─┼→ evaluate → deny > ask > allow
 *   the 5 category defaults   (source 'default') ─┘
 *
 * Precedence is deterministic (plan §WS1):
 *
 *   1. deny > ask > allow — the most restrictive EFFECT wins;
 *   2. within the same effect the MOST SPECIFIC rule wins (a rule is more
 *      specific the more of its matchers it had to satisfy: tool / category /
 *      pathPrefix / host);
 *   3. remaining ties keep declaration order — session rules are listed before
 *      project ones, so runtime intent wins an equal-specificity tie.
 *
 * With ZERO rules the engine is a no-op: the caller keeps the historical
 * 5-category semantics of toolPermissions.ts, byte-identical. This module
 * never widens a category on its own.
 *
 * Fail-closed: a malformed/unknown rule or config never silently allows.
 * `parsePermissionRuleFile` returns the error IN PLACE of the rules (naming
 * the offending file) and `evaluatePermissionPolicy` answers 'ask' — never
 * 'allow' — when nothing matched and no fallback was supplied.
 *
 * Pure: no I/O, no process state, no clock. Rule SOURCES live in
 * permissionRules.ts; the dispatch gate in permissionGate.ts.
 *
 * @since v2.56.0 (WS1 / t133)
 */
import { z } from 'zod';
import type { ToolPermission } from '@zelari/core/harness/tools/toolTypes';
import { EFFECT_RANK } from './policyEngine.js';
import type { PermissionAction } from './toolPermissions.js';

/** The three effects a rule can carry (same vocabulary as the category policy). */
export const PERMISSION_EFFECTS = ['allow', 'ask', 'deny'] as const;

/** The 5 category semantics of toolPermissions.ts — the DEFAULT source. */
export const PERMISSION_RULE_CATEGORIES = ['read', 'write', 'execute', 'network', 'ui'] as const;

/**
 * `$comment` — the ONE non-policy key both schemas tolerate: a documentation
 * slot the WS1 template writes at the top level of `.zelari/permissions.json`
 * (a rule may carry its own for the same purpose).
 *
 * It is ACCEPTED AND STRIPPED: the content is never validated and never reaches
 * the engine, so documentation can never change a decision. Without this the
 * `.strict()` schemas rejected the shipped 0-rule template as malformed, and
 * since a malformed config fails closed (every call 'ask') the effect was the
 * exact OPPOSITE of a rule-less file: nothing at all was allowed in a
 * non-interactive context. Every OTHER unknown key is still a MALFORMED config
 * (a typo'd `efect:` keeps failing closed, naming its path).
 */
const commentSchema = z.string().optional();

/** Shallow copy of a validated object without its documentation slot. */
function stripComment<T extends object>(value: T & { $comment?: string }): Omit<T, '$comment'> {
  const { $comment: _comment, ...rest } = value;
  return rest;
}

/**
 * One rule of `.zelari/permissions.json` (zod-validated, `.strict()`: an
 * unknown key — `$comment` aside — is a MALFORMED config and fails closed
 * instead of being silently ignored).
 *
 * A rule with no matcher is a catch-all (specificity 0) — the only way to say
 * "deny everything" — and loses every same-effect tie against a rule that
 * actually matched on something.
 */
export const PermissionRuleSchema = z
  .object({
    $comment: commentSchema,
    id: z.string().min(1),
    effect: z.enum(PERMISSION_EFFECTS),
    /** Tool name or '*' glob pattern (e.g. `bash`, `mcp__*`). */
    tool: z.string().min(1).optional(),
    category: z.enum(PERMISSION_RULE_CATEGORIES).optional(),
    /** Path prefix, root-relative or absolute (separator-insensitive). */
    pathPrefix: z.string().min(1).optional(),
    /** Host or domain suffix (`example.com`, `*.example.com`). */
    host: z.string().min(1).optional(),
    note: z.string().min(1).optional(),
  })
  .strict()
  .transform(stripComment);
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;
export type PermissionEffect = PermissionRule['effect'];

/** Project config location, relative to the workspace root. */
export const PERMISSION_RULE_FILE = '.zelari/permissions.json';
/** Envelope schema version of that file (additive changes keep it). */
export const PERMISSION_RULE_FILE_VERSION = 1;

/**
 * Envelope of `.zelari/permissions.json`: the version and the rules, plus the
 * `$comment` documentation slot (stripped, see above) — nothing else.
 */
export const PermissionRuleFileSchema = z
  .object({
    $comment: commentSchema,
    version: z.literal(PERMISSION_RULE_FILE_VERSION).optional(),
    rules: z.array(PermissionRuleSchema),
  })
  .strict()
  .transform(stripComment);

/** Where a rule came from. `default` = category semantics; `fail-closed` = malformed source. */
export type PermissionRuleSource = 'default' | 'project' | 'session' | 'fail-closed';

/** A rule plus its provenance (what `/permissions` lists and the event records). */
export interface ActivePermissionRule {
  rule: PermissionRule;
  source: PermissionRuleSource;
}

/** Everything the engine may look at for ONE dispatch. */
export interface PermissionRequest {
  toolName: string;
  /** Categories the tool declares (toolPermission tags). */
  categories?: readonly ToolPermission[];
  /** Candidate path values (root-relative first, then absolute — see the gate). */
  paths?: readonly string[];
  /** Destination host, when the tool talks to the network. */
  host?: string;
}

/** The engine's answer for ONE dispatch. */
export interface PermissionVerdict {
  decision: PermissionAction;
  /** id of the winning rule; absent when a fallback/category default decided. */
  matchedRuleId?: string;
  source: PermissionRuleSource;
  /** Matchers the winning rule satisfied (0 = catch-all / fallback). */
  specificity?: number;
  /** Human reason — always populated for ask/deny and for fail-closed. */
  reason: string;
}

export interface PermissionRuleMatch {
  rule: PermissionRule;
  source: PermissionRuleSource;
  specificity: number;
}

function normalizeValue(v: string): string {
  return v.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Tool name match: exact, or a `*` glob (`*`, `mcp__*`, `write_*`). */
function toolHits(pattern: string, toolName: string): boolean {
  const p = pattern.trim();
  if (!p.includes('*')) return p === toolName;
  const body = p
    .split('*')
    .map((part) => escapeRegExp(part))
    .join('.*');
  return new RegExp(`^${body}$`).test(toolName);
}

/**
 * Path prefix match against a whole-SEGMENT run: `docs` matches `docs/a.md`
 * and `/repo/docs/a.md`, but never `docs-private/a.md`. Separator- and
 * (Windows hosts, user-authored config): the DENY direction must never slip,
 * so being forgiving here fails safe.
 */
function pathPrefixHits(prefix: string, paths: readonly string[]): boolean {
  const head = `/${normalizeValue(prefix).replace(/^\/+|\/+$/g, '')}`;
  if (head === '/') return false;
  return paths.some((p) => {
    const value = `/${normalizeValue(p).replace(/^\/+|\/+$/g, '')}`;
    return value === head || value.startsWith(`${head}/`) || value.includes(`${head}/`);
  });
}

/** Host match: exact, or a domain suffix (`example.com` also matches `api.example.com`). */
function hostHits(pattern: string, host: string): boolean {
  const p = normalizeValue(pattern).replace(/^\*\.?/, '');
  if (!p) return true;
  const h = normalizeValue(host).replace(/\/+$/, '');
  return h === p || h.endsWith(`.${p}`);
}

/**
 * Match ONE rule against ONE request. Every matcher the rule DECLARES must
 * hit; the count of declared matchers is its specificity. Null = no match.
 */
export function matchPermissionRule(
  entry: ActivePermissionRule,
  request: PermissionRequest,
): PermissionRuleMatch | null {
  const { rule } = entry;
  let specificity = 0;
  if (rule.tool !== undefined) {
    if (!toolHits(rule.tool, request.toolName)) return null;
    specificity += 1;
  }
  if (rule.category !== undefined) {
    if (!(request.categories ?? []).includes(rule.category)) return null;
    specificity += 1;
  }
  if (rule.pathPrefix !== undefined) {
    if (!pathPrefixHits(rule.pathPrefix, request.paths ?? [])) return null;
    specificity += 1;
  }
  if (rule.host !== undefined) {
    if (typeof request.host !== 'string' || !hostHits(rule.host, request.host)) return null;
    specificity += 1;
  }
  return { rule, source: entry.source, specificity };
}

/**
 * The winning rule (deny > ask > allow, then most specific, then first
 * declared), or null when nothing matched — in which case the caller keeps
 * the category decision ("... > category default").
 */
export function matchPermissionRules(
  rules: readonly ActivePermissionRule[],
  request: PermissionRequest,
): PermissionRuleMatch | null {
  let best: PermissionRuleMatch | null = null;
  for (const entry of rules) {
    const hit = matchPermissionRule(entry, request);
    if (!hit) continue;
    if (best === null) {
      best = hit;
      continue;
    }
    const rank = EFFECT_RANK[hit.rule.effect] - EFFECT_RANK[best.rule.effect];
    if (rank > 0 || (rank === 0 && hit.specificity > best.specificity)) best = hit;
  }
  return best;
}

/** `[permissions:session] rule 'no-push' — never push from this repo` */
export function describePermissionRule(
  source: PermissionRuleSource,
  rule: Pick<PermissionRule, 'id' | 'note'>,
): string {
  return `[permissions:${source}] rule '${rule.id}'${rule.note ? ` — ${rule.note}` : ''}`;
}

/**
 * Stable, greppable deny line. The matched rule id is ALWAYS present (WS1
 * contract: "structured denial that NAMES the matched rule id"); the
 * fail-closed branch says so explicitly.
 */
export function formatPermissionDenial(toolName: string, verdict: PermissionVerdict): string {
  const head = describePermissionRule(verdict.source, {
    id: verdict.matchedRuleId ?? 'unknown (no rule matched)',
  });
  // A matched rule's `reason` IS `describePermissionRule(source, rule)` — the
  // very same head PLUS the rule note (see evaluatePermissionPolicy). Keep it
  // whenever it extends the head, or the note the user needs to understand WHY
  // would be dropped; a reason about something else (fail-closed) is appended
  // after the denial, as before.
  const extendsHead = verdict.reason !== '' && verdict.reason.startsWith(head);
  const named = extendsHead ? verdict.reason : head;
  const extra = verdict.reason !== '' && !extendsHead ? ` ${verdict.reason}` : '';
  return `${named} — denied "${toolName}".${extra}`;
}

/**
 * Evaluate the request against `rules`.
 *
 * `opts.fallback` is the decision to use when NO rule matched — the dispatch
 * gate passes the category decision so a rule-less setup stays a no-op. With
 * no fallback the engine FAILS CLOSED ('ask', never 'allow').
 */
export function evaluatePermissionPolicy(
  rules: readonly ActivePermissionRule[],
  request: PermissionRequest,
  opts: { fallback?: PermissionAction; fallbackReason?: string } = {},
): PermissionVerdict {
  const hit = matchPermissionRules(rules, request);
  if (hit) {
    return {
      decision: hit.rule.effect,
      matchedRuleId: hit.rule.id,
      source: hit.source,
      specificity: hit.specificity,
      reason: describePermissionRule(hit.source, hit.rule),
    };
  }
  if (opts.fallback !== undefined) {
    return {
      decision: opts.fallback,
      source: 'default',
      specificity: 0,
      reason: opts.fallbackReason ?? '',
    };
  }
  return {
    decision: 'ask',
    source: 'fail-closed',
    specificity: 0,
    reason: '[permissions] no rule matched and no category default was supplied — failing closed',
  };
}

export interface PermissionRuleFileResult {
  rules: ActivePermissionRule[];
  /** Set when the file is present but unusable — the caller fails closed. */
  error?: string;
}

/**
 * Parse `.zelari/permissions.json` (already read as text). Any problem —
 * invalid JSON, schema violation, unknown key (`$comment` aside, which is
 * stripped as documentation), duplicate rule id — returns an
 * `error` that NAMES the file and the offending field, and NO rules: the
 * engine then answers 'ask' (fail-closed), never a silent allow.
 */
export function parsePermissionRuleFile(raw: string, filePath: string): PermissionRuleFileResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { rules: [], error: `${filePath}: invalid JSON (${detail}) — failing closed` };
  }
  const parsed = PermissionRuleFileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue && issue.path.length > 0 ? issue.path.join('.') : 'file';
    return {
      rules: [],
      error: `${filePath}: invalid permissions config at '${at}': ${
        issue?.message ?? 'schema validation failed'
      } — failing closed`,
    };
  }
  const seen = new Set<string>();
  for (const rule of parsed.data.rules) {
    if (seen.has(rule.id)) {
      return { rules: [], error: `${filePath}: duplicate rule id '${rule.id}' — failing closed` };
    }
    seen.add(rule.id);
  }
  return { rules: parsed.data.rules.map((rule) => ({ rule, source: 'project' as const })) };
}
