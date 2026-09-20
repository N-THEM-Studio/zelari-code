/**
 * plugins/bundleLoad — read, validate and LOAD a WS6 plugin bundle.
 *
 * Three layers, deliberately separated:
 *
 *   1. {@link readBundle}  — I/O + validation. Reads the manifest, then checks
 *      every DECLARED path: does it exist, does it stay inside the bundle
 *      directory, and does it parse as the format it claims? Skill files go
 *      through the REAL loader parser (`skillsMd.parseSkillMd`, the same one
 *      `/skill` uses), hooks through `bundleHookDef.ts`, and MCP presets through
 *      the REAL preset registry (`bundleMcp.ts`) — nothing is re-implemented.
 *   2. {@link projectBundleContributions} — PURE. Given a bundle and the enable
 *      state it returns the contribution list, and executes NOTHING.
 *   3. {@link loadBundle} — 1 + 2, the function callers actually want.
 *
 * Fail-closed, matching the rest of the CLI: a bundle that is present but not
 * listed as enabled in `.zelari/plugins.json` contributes NOTHING (not just
 * "nothing dangerous" — nothing at all). A bundle that fails to read produces
 * no contributions, never a partial set.
 *
 * Module map: manifest schema → `bundleManifest.ts`, FS guards → `bundleFs.ts`,
 * hook-file validator → `bundleHookDef.ts`, MCP resolution → `bundleMcp.ts`,
 * discovery → `bundleDiscover.ts`, enable state → `bundleState.ts`, CLI →
 * `bundleCommand.ts`.
 *
 * @since v2.58.0 (WS6 / plugin bundle v1)
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isObserverEvent, type HookDefinition } from '@zelari/core/harness';
import { parseSkillMd, type ParsedSkillMd } from '../skillsMd.js';
import {
  BUNDLE_MANIFEST_FILE,
  parseBundleManifest,
  type BundleHookEvent,
} from './bundleManifest.js';
import { isDir, resolveInsideBundle } from './bundleFs.js';
import { readHookDefinition } from './bundleHookDef.js';
import { readMcp, type LoadedBundleMcp } from './bundleMcp.js';

export type { LoadedBundleMcp };

/** One declared SKILL.md, already parsed by the real skill parser. */
export interface LoadedBundleSkill {
  id: string;
  path: string;
  skill: ParsedSkillMd;
}

/** One declared hook: the file's own definition, `observer` = decision discarded. */
export interface LoadedBundleHook {
  event: BundleHookEvent;
  path: string;
  /** true for the v2.57 fire-and-forget events (WS5). */
  observer: boolean;
  definition: HookDefinition;
}

/** A declared agent file. Validated and surfaced, never executed (see README debt). */
export interface LoadedBundleAgent {
  id: string;
  path: string;
  description?: string;
}

/** A bundle that passed every check. */
export interface LoadedBundle {
  name: string;
  version: string;
  description?: string;
  /** Absolute bundle directory. */
  dir: string;
  /** Absolute manifest path. */
  manifestPath: string;
  skills: LoadedBundleSkill[];
  hooks: LoadedBundleHook[];
  mcp: LoadedBundleMcp[];
  agents: LoadedBundleAgent[];
  warnings: string[];
}

export interface BundleReadResult {
  /** Present only when `errors` is empty. */
  bundle?: LoadedBundle;
  errors: string[];
  warnings: string[];
}

/** Read the declared skills, each through the real SKILL.md parser. */
async function readSkills(
  manifestSkills: readonly { id: string; path: string }[],
  root: string,
  manifestPath: string,
  errors: string[],
): Promise<LoadedBundleSkill[]> {
  const skills: LoadedBundleSkill[] = [];
  for (let i = 0; i < manifestSkills.length; i += 1) {
    const ref = manifestSkills[i]!;
    const abs = await resolveInsideBundle(root, ref.path, `skills.${i}.path`, manifestPath, errors);
    if (!abs) continue;
    const skill = parseSkillMd(await readFile(abs, 'utf8'), abs);
    if (!skill) {
      errors.push(
        `${manifestPath}: invalid bundle manifest at 'skills.${i}.path': '${ref.path}' is not a valid SKILL.md ` +
          '(needs YAML frontmatter with name + description and a non-empty body)',
      );
      continue;
    }
    if (skill.name !== ref.id) {
      errors.push(
        `${manifestPath}: invalid bundle manifest at 'skills.${i}.id': id '${ref.id}' ` +
          `does not match the SKILL.md name '${skill.name}' in '${ref.path}'`,
      );
      continue;
    }
    skills.push({ id: ref.id, path: abs, skill });
  }
  return skills;
}

/** Read the declared hooks, each validated against the event it claims. */
async function readHooks(
  manifestHooks: readonly {
    event: BundleHookEvent;
    path: string;
    config?: { timeoutMs?: number; cwd?: string };
  }[],
  root: string,
  manifestPath: string,
  errors: string[],
  warnings: string[],
): Promise<LoadedBundleHook[]> {
  const hooks: LoadedBundleHook[] = [];
  for (let i = 0; i < manifestHooks.length; i += 1) {
    const ref = manifestHooks[i]!;
    const abs = await resolveInsideBundle(root, ref.path, `hooks.${i}.path`, manifestPath, errors);
    if (!abs) continue;
    const result = readHookDefinition(await readFile(abs, 'utf8'), abs, ref.event, warnings);
    if (!result.definition) {
      errors.push(
        `${manifestPath}: invalid bundle manifest at 'hooks.${i}.path': ${result.error ?? 'invalid hook'}`,
      );
      continue;
    }
    // `hooks[].config` may only override timeoutMs/cwd — the hook FILE owns
    // command, url, match and name (see the schema).
    hooks.push({
      event: ref.event,
      path: abs,
      observer: isObserverEvent(ref.event),
      definition: { ...result.definition, ...(ref.config ?? {}) },
    });
  }
  return hooks;
}

/**
 * Read + validate one bundle directory. Never throws: every problem is an
 * entry in `errors` naming the file and the field.
 */
export async function readBundle(
  dir: string,
  manifestFileName: string = BUNDLE_MANIFEST_FILE,
): Promise<BundleReadResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const root = path.resolve(dir);
  const manifestPath = path.join(root, manifestFileName);

  if (!(await isDir(root))) {
    return { errors: [`${root}: not a bundle directory`], warnings };
  }
  let manifestRaw: string;
  try {
    manifestRaw = await readFile(manifestPath, 'utf8');
  } catch {
    return { errors: [`${manifestPath}: bundle manifest not found`], warnings };
  }
  const parsed = parseBundleManifest(manifestRaw, manifestPath);
  if (!parsed.manifest) return { errors: parsed.errors, warnings };
  const manifest = parsed.manifest;

  const skills = await readSkills(manifest.skills, root, manifestPath, errors);
  const hooks = await readHooks(manifest.hooks, root, manifestPath, errors, warnings);
  const mcp = readMcp(manifest.mcp, manifestPath, errors, warnings);

  const agents: LoadedBundleAgent[] = [];
  for (let i = 0; i < manifest.agents.length; i += 1) {
    const ref = manifest.agents[i]!;
    const at = `agents.${i}.path`;
    const abs = await resolveInsideBundle(root, ref.path, at, manifestPath, errors);
    if (!abs) continue;
    if ((await readFile(abs, 'utf8')).trim() === '') {
      errors.push(`${manifestPath}: invalid bundle manifest at '${at}': '${ref.path}' is empty`);
      continue;
    }
    agents.push({ id: ref.id, path: abs, ...(ref.description ? { description: ref.description } : {}) });
  }
  if (agents.length > 0) {
    warnings.push('agents are declared and validated but NOT executed (no agent loader in this release)');
  }

  if (errors.length > 0) return { errors, warnings };
  return {
    bundle: {
      name: manifest.name,
      version: manifest.version,
      ...(manifest.description ? { description: manifest.description } : {}),
      dir: root,
      manifestPath,
      skills,
      hooks,
      mcp,
      agents,
      warnings,
    },
    errors,
    warnings,
  };
}

/** What one enabled bundle contributes. Empty arrays when `enabled` is false. */
export interface BundleContributions {
  bundle: string;
  version: string;
  dir: string;
  enabled: boolean;
  skills: LoadedBundleSkill[];
  hooks: LoadedBundleHook[];
  mcp: LoadedBundleMcp[];
  agents: LoadedBundleAgent[];
  warnings: string[];
}

/**
 * PURE projection: bundle + enable state → contribution list. Executes nothing
 * and reads nothing. A disabled bundle contributes NOTHING (fail-closed), which
 * is the seam a future apply/eval step consumes.
 */
export function projectBundleContributions(
  bundle: LoadedBundle,
  opts: { enabled: boolean },
): BundleContributions {
  const base = {
    bundle: bundle.name,
    version: bundle.version,
    dir: bundle.dir,
    warnings: bundle.warnings,
  };
  if (!opts.enabled) {
    return { ...base, enabled: false, skills: [], hooks: [], mcp: [], agents: [] };
  }
  return {
    ...base,
    enabled: true,
    skills: bundle.skills,
    hooks: bundle.hooks,
    mcp: bundle.mcp,
    agents: bundle.agents,
  };
}

export interface BundleLoadResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** Present only when `ok` (the bundle read cleanly). */
  contributions?: BundleContributions;
}

/** Read + validate + project. `ok:false` ⇒ no contributions, never partial. */
export async function loadBundle(
  dir: string,
  opts: { enabled: boolean },
): Promise<BundleLoadResult> {
  const read = await readBundle(dir);
  if (!read.bundle) return { ok: false, errors: read.errors, warnings: read.warnings };
  return {
    ok: true,
    errors: [],
    warnings: read.warnings,
    contributions: projectBundleContributions(read.bundle, { enabled: opts.enabled }),
  };
}
