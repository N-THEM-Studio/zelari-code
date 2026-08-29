/**
 * extensions/loader.ts — disk loading for the ExtensionAPI seam (t30).
 *
 * Trust model (mirrors safety/lifecycleHooks.ts):
 *   1. `~/.zelari-code/extensions/*`  — user-global, ALWAYS active
 *   2. `<project>/.zelari/extensions/*` — active ONLY when the folder is
 *      trusted (folderTrust.ts). Like project MCP + project hooks, trust
 *      gates project self-execution; it NEVER touches policy.json.
 *
 * Code arrives from DISK ONLY — `import()` of real files, never strings
 * from the model/prompt (ADR-0022: seam, not a plugin framework).
 *
 * Optional `extensions.lock` (same dir, JSON): maps FILE name → sha256 of
 * the file bytes. The hash check runs BEFORE the dynamic import, so an
 * unverified module is never evaluated. If a lock exists and any candidate
 * file is missing from it or hashes differently:
 *   - strict surface (activePolicyLoadMode strict — headless/mission/CI):
 *     the WHOLE load FAILS with a typed ExtensionLockError (no silent skip,
 *     no partial load); the host decides how loudly to die.
 *   - permissive (TUI): warn + skip the offending file, load the rest.
 *
 * @since 2.22.0 (t30)
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  ExtensionRegistry,
  type SandboxedFs,
  type ZelariExtension,
} from '@zelari/core/harness';
import type { PolicyLoadMode } from '../safety/policyEngine.js';
import { activePolicyLoadMode } from '../safety/policyLoadMode.js';
import { isFolderTrusted } from '../safety/folderTrust.js';
import { bindSandboxedFs } from './sandboxedFs.js';

/** `~/.zelari-code/extensions` — user-global extensions (always active). */
export function globalExtensionsDir(): string {
  return join(homedir(), '.zelari-code', 'extensions');
}

/** `<project>/.zelari/extensions` — project extensions (trusted only). */
export function projectExtensionsDir(projectRoot: string): string {
  return join(projectRoot, '.zelari', 'extensions');
}

/** Lockfile name, co-located with the extension files. */
export const EXTENSIONS_LOCK_FILE = 'extensions.lock';

const EXTENSION_FILE_EXTS = new Set(['.js', '.mjs', '.cjs']);

/**
 * Typed strict-mode failure (same spirit as PolicyLoadError): the caller
 * gets a machine-readable reason list, one entry per offending file.
 */
export class ExtensionLockError extends Error {
  constructor(
    message: string,
    readonly mismatches: readonly string[],
  ) {
    super(message);
    this.name = 'ExtensionLockError';
  }
}

export interface ExtensionSourceDir {
  path: string;
  scope: 'global' | 'project';
}

export interface LoadedExtensionInfo {
  id: string;
  file: string;
  scope: 'global' | 'project';
}

export interface LoadedExtensionRuntime {
  registry: ExtensionRegistry;
  loaded: LoadedExtensionInfo[];
  /** Files/modules not loaded, with reasons (permissive skips, invalid shapes). */
  skipped: string[];
}

export type ExtensionsLoadResult =
  | { ok: true; runtime: LoadedExtensionRuntime }
  | { ok: false; error: ExtensionLockError; skipped: string[] };

export interface LoadExtensionsOptions {
  /** Default: activePolicyLoadMode() (strict on headless/mission/CI). */
  mode?: PolicyLoadMode;
  /** Sandbox root for the injected fs (default process.cwd()). */
  fsRoot?: string;
  /** Logger sink (default console.error). */
  logger?: (msg: string) => void;
  /** Import seam (tests). Default: native dynamic import of the file URL. */
  importModule?: (file: string) => Promise<unknown>;
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function candidateFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // dir missing → no extensions (same as hooks/MCP dirs)
  }
  return names
    .filter((n) => EXTENSION_FILE_EXTS.has(n.slice(n.lastIndexOf('.')).toLowerCase()))
    .sort()
    .map((n) => join(dir, n));
}

/** Extract + validate the ZelariExtension export from a module namespace. */
function extractExtension(mod: unknown): ZelariExtension | null {
  const m = mod as Record<string, unknown> | null | undefined;
  const candidate = (m && typeof m === 'object' && m !== null ? m['default'] : undefined) ??
    (m && typeof m === 'object' ? m['extension'] : undefined) ??
    (m && typeof m === 'object' ? m['zelariExtension'] : undefined);
  if (!candidate || typeof candidate !== 'object') return null;
  const ext = candidate as Record<string, unknown>;
  if (typeof ext['id'] !== 'string' || ext['id'].trim() === '') return null;
  if (typeof ext['register'] !== 'function') return null;
  return candidate as unknown as ZelariExtension;
}

/**
 * Load extensions from explicit dirs (global first, project second).
 * Never throws: strict lock violations come back as `{ ok: false, error }`,
 * everything else is a loud skip recorded in `skipped`.
 */
export async function loadExtensionsFromDirs(
  dirs: readonly ExtensionSourceDir[],
  options: LoadExtensionsOptions = {},
): Promise<ExtensionsLoadResult> {
  const logger = options.logger ?? ((msg: string) => console.error(`[extensions] ${msg}`));
  const mode = options.mode ?? activePolicyLoadMode();
  const importModule = options.importModule ?? ((file) => import(pathToFileURL(file).href));
  const skipped: string[] = [];
  const runtime: LoadedExtensionRuntime = {
    registry: new ExtensionRegistry(),
    loaded: [],
    skipped,
  };
  const fsRoot = options.fsRoot ?? process.cwd();
  let fs: SandboxedFs | null = null;

  // Phase 1 — INTEGRITY: verify every candidate against its dir lock (if
  // any) BEFORE importing anything. A strict mismatch aborts the whole load.
  const pending: Array<{ file: string; scope: 'global' | 'project' }> = [];
  for (const dir of dirs) {
    const files = candidateFiles(dir.path);
    if (files.length === 0) continue;
    let lock: Record<string, unknown> | null = null;
    try {
      lock = JSON.parse(readFileSync(join(dir.path, EXTENSIONS_LOCK_FILE), 'utf8')) as Record<string, unknown>;
    } catch {
      lock = null; // no/invalid lock file → no hash gate (documented optional)
      if (dirHasLockFile(dir.path)) {
        skipped.push(`${EXTENSIONS_LOCK_FILE} in ${dir.path}: unreadable — lock ignored`);
      }
    }
    for (const file of files) {
      if (!lock) {
        pending.push({ file, scope: dir.scope });
        continue;
      }
      const expected = lock[basenameOf(file)];
      const actual = sha256File(file);
      if (typeof expected !== 'string' || expected.toLowerCase() !== actual.toLowerCase()) {
        const why =
          typeof expected !== 'string'
            ? 'not listed in extensions.lock'
            : 'sha256 mismatch vs extensions.lock';
        if (mode === 'strict') {
          // Collected across ALL dirs first? No — fail fast keeps the typed
          // error focused; remaining files were never imported anyway.
          return {
            ok: false,
            error: new ExtensionLockError(
              `extension "${basenameOf(file)}" in ${dir.path}: ${why}`,
              [`${file}: ${why}`],
            ),
            skipped,
          };
        }
        logger(`[extensions] skipping ${file}: ${why} (permissive mode)`);
        skipped.push(`${file}: ${why}`);
        continue;
      }
      pending.push({ file, scope: dir.scope });
    }
  }

  // Phase 2 — IMPORT + REGISTER. One bad module never takes down the batch.
  for (const { file, scope } of pending) {
    let ext: ZelariExtension | null = null;
    try {
      ext = extractExtension(await importModule(file));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger(`failed to import extension ${file}: ${msg}`);
      skipped.push(`${file}: import failed (${msg})`);
      continue;
    }
    if (!ext) {
      logger(`skipping ${file}: no default/extension export shaped like ZelariExtension`);
      skipped.push(`${file}: missing ZelariExtension export`);
      continue;
    }
    if (!fs) fs = bindSandboxedFs(fsRoot);
    try {
      await runtime.registry.registerExtension(ext, { fs });
      runtime.loaded.push({ id: ext.id, file, scope });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger(`extension "${ext.id}" (${file}) failed to register: ${msg}`);
      skipped.push(`${file}: registration failed (${msg})`);
      runtime.registry.removeExtension(ext.id);
    }
  }
  return { ok: true, runtime };
}

function basenameOf(file: string): string {
  const i = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return i === -1 ? file : file.slice(i + 1);
}

function dirHasLockFile(dir: string): boolean {
  try {
    readFileSync(join(dir, EXTENSIONS_LOCK_FILE));
    return true;
  } catch {
    return false;
  }
}

/**
 * Standard dir layout for a workspace: global extensions ALWAYS, project
 * extensions only when `projectRoot` is trusted. This is the ONLY place
 * the trust decision is made for extensions — and it never affects
 * policy.json.
 */
export function extensionSourceDirs(projectRoot: string): ExtensionSourceDir[] {
  const dirs: ExtensionSourceDir[] = [{ path: globalExtensionsDir(), scope: 'global' }];
  if (isFolderTrusted(projectRoot)) {
    dirs.push({ path: projectExtensionsDir(projectRoot), scope: 'project' });
  }
  return dirs;
}

/** Convenience: load with the standard dir layout for a workspace. */
export function loadDefaultExtensionRuntime(
  projectRoot: string,
  options: LoadExtensionsOptions = {},
): Promise<ExtensionsLoadResult> {
  return loadExtensionsFromDirs(extensionSourceDirs(projectRoot), {
    fsRoot: projectRoot,
    ...options,
  });
}
