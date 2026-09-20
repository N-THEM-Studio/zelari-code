/**
 * plugins/bundleState — the PROJECT enable/disable state for plugin bundles.
 *
 * File: `<projectRoot>/.zelari/plugins.json` (project scope only — the
 * user-global `~/.zelari-code/plugins.json` belongs to plugins/prefs.ts and the
 * optional-npm-dependency catalog, and is NOT touched here).
 *
 * ```json
 * {
 *   "$comment": "optional documentation slot — accepted and stripped",
 *   "enabled": { "zelari-plugin-example": true },
 *   "paths": ["examples/extensions"]
 * }
 * ```
 *
 * FAIL-CLOSED, like every other policy surface in this CLI:
 *
 *   - a bundle that is PRESENT but not listed in `enabled` is DISABLED;
 *   - a malformed state file enables NOTHING (and says why) — it never falls
 *     back to "everything on";
 *   - `setBundleEnabled` REFUSES to write over a malformed file rather than
 *     silently discarding whatever the user had in it.
 *
 * `paths` is an additive, optional extension: the directories `plugin list`
 * SCANS for bundles (project-relative or absolute). `plugin enable <dir>`
 * registers the directory CONTAINING that bundle, so the bundle stays visible
 * in `plugin list` after being disabled — a disabled bundle you cannot see is
 * a bundle you cannot re-enable.
 *
 * @since v2.58.0 (WS6 / plugin bundle v1)
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/** State file, relative to the project root. */
export const BUNDLE_STATE_FILE = '.zelari/plugins.json';

/** `$comment` — accepted and stripped, exactly as in bundleManifest.ts. */
const BundleStateSchema = z
  .object({
    $comment: z.string().optional(),
    enabled: z.record(z.string(), z.boolean()).default({}),
    paths: z.array(z.string().min(1)).default([]),
  })
  .strict();

export interface BundleState {
  /** bundle name → enabled. Absent ⇒ DISABLED (fail-closed). */
  enabled: Record<string, boolean>;
  /** directories `plugin list` scans for bundles. */
  paths: string[];
}

/** The fail-closed default: nothing enabled, nothing configured. */
export function emptyBundleState(): BundleState {
  return { enabled: {}, paths: [] };
}

/** `<projectRoot>/.zelari/plugins.json`. */
export function bundleStatePath(projectRoot: string): string {
  return path.join(projectRoot, BUNDLE_STATE_FILE);
}

/** A bundle is enabled ONLY when explicitly listed as `true`. */
export function isBundleEnabled(state: BundleState, name: string): boolean {
  return state.enabled[name] === true;
}

export interface BundleStateReadResult {
  state: BundleState;
  path: string;
  errors: string[];
}

/**
 * Read the state file. Missing ⇒ the fail-closed default. Malformed ⇒ the
 * fail-closed default PLUS an error naming the file and the field.
 */
export async function readBundleState(projectRoot: string): Promise<BundleStateReadResult> {
  const file = bundleStatePath(projectRoot);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return { state: emptyBundleState(), path: file, errors: [] };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      state: emptyBundleState(),
      path: file,
      errors: [`${file}: invalid JSON (${detail}) — every bundle stays DISABLED`],
    };
  }
  const parsed = BundleStateSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue && issue.path.length > 0 ? issue.path.join('.') : 'file';
    return {
      state: emptyBundleState(),
      path: file,
      errors: [
        `${file}: invalid plugins state at '${at}': ${
          issue?.message ?? 'schema validation failed'
        } — every bundle stays DISABLED`,
      ],
    };
  }
  const { $comment: _comment, ...state } = parsed.data;
  return { state, path: file, errors: [] };
}

/**
 * Register the SCAN ROOT of `bundleDir` (its parent directory) in `paths`,
 * stored project-relative when it lives inside the project.
 *
 * The parent, never the bundle itself: `paths` entries are directories that may
 * CONTAIN bundles, so registering a bundle would make `plugin list` descend one
 * level too far and report its `hooks/` / `skills/` / `mcp/` subdirectories as
 * broken bundles.
 */
function withRegisteredScanRoot(state: BundleState, projectRoot: string, bundleDir: string): BundleState {
  const abs = path.dirname(path.resolve(bundleDir));
  const rel = path.relative(path.resolve(projectRoot), abs);
  const value = rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ? abs : rel;
  const paths = state.paths.map((p) => path.normalize(p));
  if (paths.includes(path.normalize(value))) return state;
  return { ...state, paths: [...state.paths, value] };
}

export interface BundleSetEnabledOptions {
  projectRoot: string;
  /** Bundle name — the key written under `enabled`. */
  name: string;
  enabled: boolean;
  /** Bundle directory whose PARENT is registered as a scan root (optional). */
  dir?: string;
}

export type BundleSetEnabledResult = { ok: true; path: string; state: BundleState } | { ok: false; error: string };

/**
 * Persist `enabled[name]`. Refuses (never overwrites) when the existing file is
 * malformed: repairing a broken state file silently would throw away whatever
 * the user meant by it.
 */
export async function setBundleEnabled(
  opts: BundleSetEnabledOptions,
): Promise<BundleSetEnabledResult> {
  const read = await readBundleState(opts.projectRoot);
  if (read.errors.length > 0) {
    return {
      ok: false,
      error: `${read.errors[0]} — refusing to overwrite it; fix the file or delete it`,
    };
  }
  const named: BundleState = {
    ...read.state,
    enabled: { ...read.state.enabled, [opts.name]: opts.enabled },
  };
  const next = opts.dir ? withRegisteredScanRoot(named, opts.projectRoot, opts.dir) : named;
  try {
    await mkdir(path.dirname(read.path), { recursive: true });
    await writeFile(read.path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, path: read.path, state: next };
}
