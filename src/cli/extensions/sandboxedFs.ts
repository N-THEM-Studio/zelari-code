/**
 * sandboxedFs.ts — CLI binding for the core `SandboxedFs` seam (t30).
 *
 * Core defines the extension-facing INTERFACE; this module binds it to the
 * real, symlink-safe sandbox resolver (safety/sandboxPath.ts): every path
 * an extension passes is resolved against the workspace root (lexical +
 * realpath layers) and writes get a `verifyContainment` re-check as the
 * last step before touching disk. Escapes surface as typed
 * `{ ok: false, error: '[extension-fs] …' }` results — never a throw into
 * extension code, and never a silent fallback.
 *
 * @since 2.22.0 (t30)
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { SandboxedFs } from '@zelari/core/harness';
import { typedErr, typedOk } from '@zelari/core/harness/tools/toolTypes';
import { resolveSandboxedPath, verifyContainment } from '../safety/sandboxPath.js';

function errText(prefix: string, p: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `[extension-fs] ${prefix} "${p}": ${msg}`;
}

/**
 * Bind the extension FS seam to `root` (normally the workspace root).
 * Relative paths are joined to the root; absolute paths must already sit
 * inside it — anything else is rejected by the shared sandbox resolver,
 * so an extension has exactly the same containment guarantees as the
 * built-in filesystem tools.
 */
export function bindSandboxedFs(root: string): SandboxedFs {
  const resolvedRoot = path.resolve(root);
  return {
    root: resolvedRoot,

    async readFile(relativePath: string) {
      try {
        const target = resolveSandboxedPath(relativePath, { root: resolvedRoot });
        const data = await fsp.readFile(target, 'utf8');
        return typedOk(data);
      } catch (err) {
        return typedErr(errText('readFile denied', relativePath, err));
      }
    },

    async writeFile(relativePath: string, data: string) {
      try {
        const target = resolveSandboxedPath(relativePath, { root: resolvedRoot });
        // TOCTOU re-check 〔PW §5〕: BOTH layers on fresh syscalls as the LAST
        // step before the mutation (same discipline as wrapWithSandbox t26).
        verifyContainment(target, { root: resolvedRoot });
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, data, 'utf8');
        return typedOk({ path: target });
      } catch (err) {
        return typedErr(errText('writeFile denied', relativePath, err));
      }
    },

    async listFiles(relativePath = '.') {
      try {
        const target = resolveSandboxedPath(relativePath, { root: resolvedRoot });
        const entries = await fsp.readdir(target, { withFileTypes: true });
        return typedOk(entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort());
      } catch (err) {
        return typedErr(errText('listFiles denied', relativePath, err));
      }
    },
  };
}
