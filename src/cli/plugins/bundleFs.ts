/**
 * plugins/bundleFs — the filesystem primitives a bundle check needs.
 *
 * Extracted so `bundleLoad.ts`, `bundleDiscover.ts` and `bundleCommand.ts`
 * agree on ONE definition of "the declared file exists and stays inside the
 * bundle" instead of each growing its own copy.
 *
 * @since v2.58.0 (WS6 / plugin bundle v1)
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';

/** `true` only for an existing regular file; never throws. */
export async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** `true` only for an existing directory; never throws. */
export async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Narrow a parsed JSON value to an object literal (not an array, not null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolve one declared bundle-relative path and prove it is a real file INSIDE
 * the bundle directory.
 *
 * `bundleManifest.ts` already rejects an absolute path or a `..` segment, so
 * this is defence in depth: a bundle may only ever read files it actually
 * contains, even if a future path rule loosens. On failure the message names
 * the manifest, the FIELD and what was wrong; `null` is returned and the
 * caller skips the entry.
 */
export async function resolveInsideBundle(
  root: string,
  relPath: string,
  at: string,
  manifestPath: string,
  errors: string[],
): Promise<string | null> {
  const abs = path.resolve(root, relPath);
  const rel = path.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    errors.push(
      `${manifestPath}: invalid bundle manifest at '${at}': path escapes the bundle directory ('${relPath}')`,
    );
    return null;
  }
  if (!(await isFile(abs))) {
    errors.push(`${manifestPath}: invalid bundle manifest at '${at}': file not found ('${relPath}')`);
    return null;
  }
  return abs;
}
