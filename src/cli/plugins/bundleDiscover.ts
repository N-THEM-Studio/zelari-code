/**
 * plugins/bundleDiscover — find bundle directories under the scan roots.
 *
 * Used by `plugin list` and by name-based `plugin enable|disable`.
 *
 * The candidate rule is deliberately narrow: a directory is a bundle ONLY when
 * it carries a manifest. Anything else — a bundle's own `hooks/` / `skills/`
 * subdirectory, or a different kind of example such as
 * `examples/extensions/echo-tool` — is not a bundle and must not be reported as
 * a broken one. A manifest that IS present but invalid still surfaces, as
 * INVALID: that one the user needs to see.
 *
 * @since v2.58.0 (WS6 / plugin bundle v1)
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { BUNDLE_MANIFEST_FILE } from './bundleManifest.js';
import { readBundle } from './bundleLoad.js';
import { isDir, isFile } from './bundleFs.js';
import type { BundleState } from './bundleState.js';

/** One candidate found while scanning bundle roots. */
export interface DiscoveredBundle {
  dir: string;
  /** Manifest name, or the directory basename when the manifest is unusable. */
  name: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
  version?: string;
}

/**
 * The roots `plugin list` scans: the repo examples, then the configured paths.
 *
 * Deduped (case-insensitively, Windows-safe): `plugin enable` records the
 * directory CONTAINING a bundle, which is very often the default root itself —
 * listing the same directory twice in the report would read as a bug.
 */
export function defaultBundleRoots(projectRoot: string, state: BundleState): string[] {
  const roots = [path.join(projectRoot, 'examples', 'extensions')];
  for (const p of state.paths) roots.push(path.resolve(projectRoot, p));
  const unique = new Map<string, string>();
  for (const root of roots) unique.set(path.resolve(root).toLowerCase(), root);
  return [...unique.values()];
}

/** Scan every root for bundle directories and validate each one. Skips dupes. */
export async function discoverBundles(roots: readonly string[]): Promise<DiscoveredBundle[]> {
  const out: DiscoveredBundle[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!(await isDir(root))) continue;
    let entries: string[];
    try {
      entries = (await readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = path.join(root, entry);
      if (!(await isFile(path.join(dir, BUNDLE_MANIFEST_FILE)))) continue;
      const key = path.resolve(dir);
      if (seen.has(key)) continue;
      seen.add(key);
      const result = await readBundle(dir);
      out.push({
        dir,
        name: result.bundle?.name ?? entry,
        ok: result.bundle !== undefined,
        errors: result.errors,
        warnings: result.warnings,
        ...(result.bundle ? { version: result.bundle.version } : {}),
      });
    }
  }
  return out;
}
