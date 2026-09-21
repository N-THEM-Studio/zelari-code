/**
 * ADR-0039 Phase 1 — the A→B syntax bridge (the Phase-2 compat SEED).
 *
 * ADR-0039 makes `policyEngine` (engine B: `.zelari/policy.json`, glob `match`)
 * the single permission engine and demotes `permissionGate` (engine A:
 * `.zelari/permissions.json`, `pathPrefix`) to a backward-compatibility
 * adapter. Phase 1 ships the observability half (one `permission.denied`
 * emission point) plus THIS pure translation, so the parity matrix
 * (permissionParity.test.ts) can compare "the same intent written twice"
 * instead of two hand-written rule sets drifting apart — and so Phase 2 (the
 * live adapter + deprecation warning) has one tested place to land.
 *
 * Pure by construction: no fs, no env, no cache, no side effect. The caller
 * decides where the result goes and whether to warn (Phase 2 owns the note).
 *
 * HONEST EDGES (recorded here, not hidden — a "translation" that over-matches
 * is not benign: A's `pathPrefix` also drives ALLOW rules, so a wider glob can
 * hand out more than the user asked for):
 *
 *   1. `pathPrefix: 'secrets'` means "this path AND everything under it"
 *      (permissionPolicy.pathPrefixHits: whole-segment run, separator- and
 *      case-insensitive). B's glob cannot say that in ONE pattern: `*` and `**`
 *      both cross `/` (policyEngine.globToRegExp), so `secrets*` would also
 *      match `secrets-old/x` — wider than A — while a bare `secrets/**` would
 *      miss the node itself. TWO patterns are emitted for the common case: the
 *      node and its subtree.
 *   2. Case: A lowercases both sides (`normalizeValue`), B is case-sensitive.
 *      The translation does not fold case, because folding it here would be
 *      invisible to the operator; Phase 2 decides (the parity matrix keeps its
 *      rows lowercase so the difference cannot hide a real divergence).
 *   3. Glob metacharacters in a prefix (`*`, `?`, `[`) are LITERAL in A and
 *      WILDCARDS in B, and `globToRegExp` offers no escape (`*` is consumed
 *      before the escape table). Such a prefix is not faithfully expressible.
 *   4. What has no native home today returns NO rules rather than an over-broad
 *      catch-all: a `tool`/`host`-only rule and the `read`/`network`/`ui`
 *      categories (B's lists are keyed by the `execute`/`write` dimension).
 *      Phase 2 (`claims`: path / process / network) or Phase 3 (removal) owns
 *      them; inventing `match: '*'` would silently widen the user's intent.
 *
 * @since v2.57.0 (ADR-0039 Phase 1 / t147)
 */
import type { PolicyRule } from './policyEngine.js';
import type { PermissionRule } from './permissionPolicy.js';

/** Which native rule list a translated rule belongs in (see PolicyRuleSet). */
export type NativeRuleList = 'shell' | 'edit';

/** One native placement of one A rule: because 1 A rule ≠ always 1 B rule. */
export interface TranslatedPermissionRule {
  list: NativeRuleList;
  rule: PolicyRule;
}

/** The two native lists, ready for a `PolicyRuleSet` (or a layer inside one). */
export interface TranslatedRuleSet {
  shell: PolicyRule[];
  edit: PolicyRule[];
}

/**
 * The globs that mean "this path and everything under it", in A's semantics.
 *
 * Normalization mirrors `normalizeValue` + `pathPrefixHits`: backslashes (the
 * Windows config a user may have written) become `/`, duplicate `/` collapse,
 * surrounding `/` is dropped — case is NOT folded (edge 2 above).
 *
 * Returns `[]` for a prefix made only of separators: A's `pathPrefixHits`
 * refuses a `head` of `/`, so such a rule matches NOTHING — mirroring it with a
 * catch-all would turn a dead rule into a blanket restriction.
 */
export function translatePathPrefix(prefix: string): string[] {
  const node = prefix
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (node === '') return [];
  return [node, `${node}/**`];
}

/**
 * Translate ONE `.zelari/permissions.json` rule into native B rules.
 *
 *   - `pathPrefix`     → the `edit` list (paths are what that list matches),
 *     1..2 patterns (see `translatePathPrefix`); a `write` category next to it
 *     only restates what the `edit` list already implies;
 *   - `category: 'execute'` → the `shell` list, `match: '*'` (A's matcher has
 *     no command dimension either: the whole execute category is covered);
 *   - `category: 'write'`   → the `edit` list, `match: '*'`;
 *   - anything else        → `[]` (edge 4 above).
 *
 * The A rule's `note` is carried over as the native `reason`: it is the same
 * human explanation, and B surfaces it in the very same deny/ask messages.
 * A rule mixing `execute` with a `pathPrefix` is NOT translatable (an execute
 * tool has no path argument) and yields `[]` rather than half a rule.
 */
export function translatePermissionRule(rule: PermissionRule): TranslatedPermissionRule[] {
  const native = (match: string): PolicyRule =>
    rule.note !== undefined
      ? { match, effect: rule.effect, reason: rule.note }
      : { match, effect: rule.effect };
  if (rule.pathPrefix !== undefined) {
    if (rule.category !== undefined && rule.category !== 'write') return [];
    return translatePathPrefix(rule.pathPrefix).map((match) => ({
      list: 'edit' as const,
      rule: native(match),
    }));
  }
  if (rule.category === 'execute') return [{ list: 'shell', rule: native('*') }];
  if (rule.category === 'write') return [{ list: 'edit', rule: native('*') }];
  return [];
}

/**
 * Translate a whole A file (`.zelari/permissions.json`'s `rules`) into the
 * native pair of lists. DECLARATION ORDER is preserved inside each list: B's
 * `resolvePolicyRule` is FIRST-MATCH-WINS, so reordering here would change
 * verdicts without changing a single rule.
 */
export function translatePermissionRules(rules: readonly PermissionRule[]): TranslatedRuleSet {
  const out: TranslatedRuleSet = { shell: [], edit: [] };
  for (const rule of rules) {
    for (const translated of translatePermissionRule(rule)) out[translated.list].push(translated.rule);
  }
  return out;
}
