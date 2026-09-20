/**
 * WS1 / t133 — permission RULE SOURCES.
 *
 * The engine (permissionPolicy.ts) is pure; this module owns the two stateful
 * sources it evaluates:
 *
 *   - 'project': `.zelari/permissions.json` in the workspace root, zod-validated
 *     (user-authored, DERIVE-ONLY — no other persistent state is created).
 *     A missing file is the historical behavior (no rules); a MALFORMED file
 *     fails closed with an error naming the file.
 *   - 'session': in-memory rules added/removed at runtime by `/permissions
 *     add|remove`. Never persisted, dropped with the process.
 *
 * The 'default' source is not a rule list at all: it is the 5-category
 * semantics of toolPermissions.ts, applied by the dispatch gate when no rule
 * says anything about the call.
 *
 * @since v2.56.0 (WS1 / t133)
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  PERMISSION_RULE_FILE,
  PermissionRuleSchema,
  parsePermissionRuleFile,
  type ActivePermissionRule,
  type PermissionRule,
} from './permissionPolicy.js';

interface LoadedProjectRules {
  rules: ActivePermissionRule[];
  error?: string;
  path: string;
}

interface ProjectCacheEntry {
  path: string;
  mtimeMs: number;
  size: number;
  result: LoadedProjectRules;
}

let projectCache: ProjectCacheEntry | null = null;

/** Absolute path of the project config for a workspace root. */
export function projectPermissionRulesPath(root: string): string {
  return path.join(root, PERMISSION_RULE_FILE.split('/').join(path.sep));
}

function statOnce(file: string): { mtimeMs: number; size: number } | null {
  try {
    const s = statSync(file);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Read + validate `.zelari/permissions.json`.
 *
 * - absent  → `{ rules: [] }` (identical to a pre-WS1 tree);
 * - malformed/unreadable → `{ rules: [], error }` with the file name inside the
 *   message; the gate turns that into a fail-closed 'ask'.
 *
 * Cached by (path, mtimeMs, size) so the per-dispatch call is a stat, not a
 * read — editing the file takes effect on the next dispatch without a restart.
 * Sync on purpose: the file is a few hundred bytes and this runs on the hot
 * dispatch path where an async hop per tool call buys nothing.
 */
export function loadProjectPermissionRules(root: string): LoadedProjectRules {
  const file = projectPermissionRulesPath(root);
  let stat: { mtimeMs: number; size: number } | null;
  try {
    stat = statOnce(file);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { rules: [], error: `${file}: unreadable (${detail}) — failing closed`, path: file };
  }
  if (stat === null) return { rules: [], path: file }; // ENOENT → no project rules
  const cached = projectCache;
  if (cached && cached.path === file && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.result;
  }
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { rules: [], error: `${file}: unreadable (${detail}) — failing closed`, path: file };
  }
  const result: LoadedProjectRules = { ...parsePermissionRuleFile(raw, file), path: file };
  projectCache = { path: file, mtimeMs: stat.mtimeMs, size: stat.size, result };
  return result;
}

/** Drop the project-file cache (tests). */
export function resetProjectPermissionRuleCache(): void {
  projectCache = null;
}

// ── Session rules (in-memory, runtime-only) ────────────────────────────────

const sessionRules: PermissionRule[] = [];

/**
 * Add (or replace, by id) a SESSION rule. The argument is zod-validated: an
 * invalid rule is REJECTED with a reason and the store is left untouched —
 * `/permissions add` never half-applies.
 *
 * An unconstrained `allow` (no matcher at all) is rejected too: it would
 * silently defeat every other source.
 */
export function addSessionPermissionRule(
  raw: unknown,
): { ok: true; rule: PermissionRule } | { ok: false; error: string } {
  const parsed = PermissionRuleSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue && issue.path.length > 0 ? issue.path.join('.') : 'rule';
    return {
      ok: false,
      error: `invalid rule at '${at}': ${issue?.message ?? 'schema validation failed'}`,
    };
  }
  const rule = parsed.data;
  const constrained =
    rule.tool !== undefined ||
    rule.category !== undefined ||
    rule.pathPrefix !== undefined ||
    rule.host !== undefined;
  if (rule.effect === 'allow' && !constrained) {
    return {
      ok: false,
      error: `rule '${rule.id}': an unconstrained 'allow' needs at least one matcher`,
    };
  }
  const at = sessionRules.findIndex((r) => r.id === rule.id);
  if (at >= 0) sessionRules[at] = rule;
  else sessionRules.push(rule);
  return { ok: true, rule };
}

export function removeSessionPermissionRule(id: string): boolean {
  const at = sessionRules.findIndex((r) => r.id === id);
  if (at < 0) return false;
  sessionRules.splice(at, 1);
  return true;
}

/** Session rules in declaration order (see the engine for tie-breaking). */
export function listSessionPermissionRules(): ActivePermissionRule[] {
  return sessionRules.map((rule) => ({ rule, source: 'session' as const }));
}

export function clearSessionPermissionRules(): void {
  sessionRules.length = 0;
}

/**
 * Every rule the gate must evaluate for a workspace: SESSION first (runtime
 * intent owns an equal-specificity tie), then PROJECT. `error` is set when the
 * project file is malformed — the caller must fail closed.
 */
export function activePermissionRules(root: string): {
  rules: ActivePermissionRule[];
  error?: string;
} {
  const project = loadProjectPermissionRules(root);
  const rules = [...listSessionPermissionRules(), ...project.rules];
  return project.error !== undefined ? { rules, error: project.error } : { rules };
}
