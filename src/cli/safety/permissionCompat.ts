/**
 * ADR-0039 Phase 2 — the LIVE compat adapter: `.zelari/permissions.json`
 * honored THROUGH engine B.
 *
 * ADR-0039 makes `policyEngine` (engine B: `.zelari/policy.json`, glob `match`)
 * the single permission engine and demotes `permissionGate` (engine A:
 * `.zelari/permissions.json`, `pathPrefix`) to a backward-compatibility adapter.
 * Phase 1 (t147) shipped the observability half (one `permission.denied`
 * emission point) plus the PURE translation, `permissionAdapter`. This module is
 * the Phase-2 half: it reads A's file with A's OWN loader, translates its rules
 * into native globs and hands them to `policyEngine.loadPolicySet`, which
 * injects them as the `compat` slot of the B stack
 * (`LayeredPolicyRuleSet.compat`, combined restrict-only by policyLayers.ts). A
 * rule written in the A syntax is therefore EVALUATED BY B from now on, not only
 * by A — which stays in place until Phase 3, so the transitional
 * double-evaluation is deliberate (permissionParity.test.ts asserts the two
 * verdicts are identical, permissionCompat.test.ts that B really decides).
 *
 * Decisions this module states out loud, because each one is a contract:
 *
 *   1. ONE warning, ON LOAD. The deprecation notice is built here, once per
 *      load, and travels in `PolicySet.warnings`; hosts print it when they build
 *      a registry. Never per dispatch: nothing here is on the hot path
 *      (loadPolicySet runs once per registry build).
 *   2. NO emission. `permission.denied` is recorded by the one emission point of
 *      Phase 1 (the final deny branch in toolRegistry.ts) and by nothing else: a
 *      deny decided by a translated rule is observable *through* that event's
 *      reason, never as a second event.
 *   3. NEVER silently ignored, NEVER fatal. Absent file → no warning, no layer
 *      (the historical behavior: most trees have none), and a file that exists
 *      but declares no rule → same, there is nothing to deprecate. A
 *      PRESENT-but-unusable file → no layer plus a warning naming it, while
 *      engine A keeps failing closed ('ask') on it. B's strict mode is
 *      deliberately NOT extended to this file: ADR-0039 §3 keeps exit 2 for an
 *      explicit strict `policy.json` load, so a user config that A already
 *      degrades to `ask` can never brick a headless/CI run instead.
 *   4. The TRANSLATION is `permissionAdapter`'s alone. Not one character of the
 *      A→B syntax mapping lives here, declaration order included (B is
 *      first-match-wins, so order is meaning).
 *   5. Dropped rules are NAMED. `translatePermissionRule` returns [] for A rules
 *      with no native home (tool-/host-only rules, the read/network/ui
 *      categories — the adapter's documented "honest edges"); the count is
 *      reported in the warning instead of vanishing. They stay enforced by
 *      engine A until Phase 3.
 *   6. Restrict-only, always. The layer can only ADD restriction to the category
 *      decision (policyLayers.intersectEffects): a translated `allow` never
 *      relaxes a deny/ask from another layer or from the category. Coverage
 *      note: `matchResourceClaimLayered` (resourceClaims.ts) reads the
 *      project/global slots only, so a translated rule is matched against the
 *      PRIMARY argument — every other path a multi-argument tool can touch is
 *      still covered by engine A's own path/claim expansion until Phase 3.
 *
 * Transitional dependency (dies with this file in Phase 3): A's loader
 * (`permissionRules.loadProjectPermissionRules`, mtime cache included) is
 * imported on purpose — "never silently ignored" has to mean the SAME verdict as
 * the file the gate reads, and re-reading it here would be a second source of
 * truth. That loader reaches back into policyEngine for EFFECT_RANK, so this
 * module closes a policyEngine → permissionCompat → permissionRules →
 * permissionPolicy → policyEngine loop; it is benign (neither module reads the
 * other's bindings while being evaluated) and it disappears with Phase 3.
 *
 * @since v2.58.0 (ADR-0039 Phase 2)
 */
import type { PolicyRuleSet } from './policyEngine.js';
import { translatePermissionRule, translatePermissionRules } from './permissionAdapter.js';
import { loadProjectPermissionRules } from './permissionRules.js';

/**
 * Greppable marker on every warning this module produces. Hosts (`toolRegistry`)
 * print the tagged lines from `PolicySet.warnings` once per registry build, so a
 * deprecation notice can never be drowned with rule diagnostics.
 */
export const COMPAT_WARNING_TAG = '[ADR-0039 compat]';

/**
 * How long the deprecated file keeps working: **two minor releases** (ADR-0039
 * §1 / "Decision 1"). The count appears verbatim in the load-time warning.
 */
export const COMPAT_REMOVAL_MINOR_RELEASES = 2;

/** What the compat loader hands back to `loadPolicySet`. */
export interface CompatPolicyLoad {
  /**
   * The translated native layer — present ONLY when the file exists, parses AND
   * produced at least one B rule. Absent means "nothing to inject": absent file,
   * rule-less file, unusable file, or rules with no native home (3 and 5 above).
   */
  compat?: PolicyRuleSet;
  /** Load-time warnings, each tagged with {@link COMPAT_WARNING_TAG}. */
  warnings: string[];
}

/**
 * The ONE deprecation notice: it names the file, says what "honored through the
 * compat layer" means (the translation, with its own counts) and how long the
 * file survives. Counts are derived from the translator, so they cannot drift.
 */
function deprecationWarning(file: string, rules: number, native: number, dropped: number): string {
  const translation =
    `${rules} rule(s) translated to ${native} engine-B glob rule(s) ` +
    "(pathPrefix -> edit 'match' node + '/**' subtree, category execute -> shell '*'; " +
    'declaration order kept, first match wins)';
  const fallback =
    dropped > 0
      ? ` ${dropped} rule(s) have no engine-B equivalent and stay enforced by engine A only.`
      : '';
  return (
    `${COMPAT_WARNING_TAG} ${file}: DEPRECATED - still honored through engine B via the ADR-0039 ` +
    `compat layer: ${translation}. Removed after ${COMPAT_REMOVAL_MINOR_RELEASES} minor releases ` +
    '(no earlier than v2.59 - ADR-0039 Phase 3): migrate to .zelari/policy.json, see MIGRATION.md.' +
    fallback
  );
}

/**
 * Read + translate `.zelari/permissions.json` for engine B.
 *
 * Read-only and cache-respecting: A's loader owns the file access (and the
 * mtime/size cache, so this is a stat on the warm path), `permissionAdapter` owns
 * the syntax mapping, and this function owns only the two decisions left — does
 * a layer exist, and what is the operator told.
 *
 * `ZELARI_POLICY=0` never reaches this code: `loadPolicySet` returns the empty
 * set before reading anything, which is exactly what that opt-out promises. It
 * disables engine B only — engine A keeps evaluating the file on its own path.
 */
export function loadCompatPolicyLayer(root: string): CompatPolicyLoad {
  const project = loadProjectPermissionRules(root);
  if (project.error !== undefined) {
    return {
      warnings: [
        `${COMPAT_WARNING_TAG} ${project.error} - no compat layer injected (ADR-0039 Phase 2). ` +
          'Engine A keeps failing closed on this dispatch path; a malformed USER config never ' +
          'blocks a run (ADR-0039 §3 keeps exit 2 for an explicit strict policy.json load).',
      ],
    };
  }
  // Nothing to honor and nothing to lose: an absent file and a rule-less file are
  // one and the same here — the template WS1 ships is `{ "$comment": …, rules: [] }`,
  // so warning about it would make every fresh tree noisy about a file that
  // decides nothing.
  if (project.rules.length === 0) return { warnings: [] };
  const rules = project.rules.map((entry) => entry.rule);
  const translated = translatePermissionRules(rules);
  const native = translated.shell.length + translated.edit.length;
  // Asked rule by rule so the notice can say how many rules B cannot express
  // (the layer itself comes from the canonical whole-file translation).
  const dropped = rules.filter((rule) => translatePermissionRule(rule).length === 0).length;
  const warnings = [deprecationWarning(project.path, rules.length, native, dropped)];
  return native > 0 ? { compat: translated, warnings } : { warnings };
}
