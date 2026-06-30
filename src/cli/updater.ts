/**
 * updater — npm registry self-update mechanism for zelari-coder.
 *
 * Functions:
 *   - getCurrentVersion(): reads bundled package.json
 *   - checkForUpdate(): fetches https://registry.npmjs.org/zelari-coder/latest,
 *     compares semver, returns { currentVersion, latestVersion, updateAvailable }
 *   - performUpdate(): spawns `npm install -g zelari-coder@latest`,
 *     captures stdout/stderr, returns { ok, output, error? }
 *
 * All network + spawn operations are injectable for testing (see tests).
 *
 * Channel: `latest` only (locked per user decision, v3-N).
 * No self-restart: caller is expected to display "please restart manually".
 *
 * @see docs/plans/2026-06-30-anathema-coder-v3-N.md
 */

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Read the bundled package.json and return its version.
 * Falls back to '0.0.0' if the file cannot be resolved (very unlikely).
 */
export function getCurrentVersion(): string {
  try {
    // Resolve from the package root (this file lives at <pkg>/electron/cli/updater.ts
    // or <pkg>/dist/electron/cli/updater.js after build)
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const pkg = require(pkgPath) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  /** Set when the registry was unreachable or returned invalid data. */
  error?: string;
}

export interface UpdatePerformResult {
  ok: boolean;
  output: string;
  error?: string;
  /** Exit code from npm (0 = success). */
  exitCode: number | null;
}

/**
 * Compare two semver strings. Returns:
 *   -1 if a < b
 *    0 if a === b
 *    1 if a > b
 *
 * Handles standard semver (MAJOR.MINOR.PATCH) with optional pre-release
 * (e.g. "1.0.0-beta.1"). Pre-release is treated as LOWER than the
 * release with the same MAJOR.MINOR.PATCH.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string): [number, number, number, string | null] => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
    if (!m) return [0, 0, 0, null];
    return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? null];
  };
  const [a1, a2, a3, aPre] = parse(a);
  const [b1, b2, b3, bPre] = parse(b);

  if (a1 !== b1) return a1 < b1 ? -1 : 1;
  if (a2 !== b2) return a2 < b2 ? -1 : 1;
  if (a3 !== b3) return a3 < b3 ? -1 : 1;
  // Same MAJOR.MINOR.PATCH: pre-release < release
  if (aPre === bPre) return 0;
  if (aPre === null) return 1;
  if (bPre === null) return -1;
  return aPre < bPre ? -1 : 1;
}

/** Public URL for the package on the npm registry. */
export const REGISTRY_URL = 'https://registry.npmjs.org/zelari-coder/latest';

/**
 * Fetch the latest version from the npm registry.
 * Injectable `fetcher` for tests (defaults to global fetch with 5s timeout).
 */
export async function fetchLatestVersion(
  fetcher: typeof fetch = fetch,
  registryUrl: string = REGISTRY_URL,
  timeoutMs = 5000,
): Promise<{ version: string } | { error: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetcher(registryUrl, { signal: controller.signal });
    clearTimeout(timer);

    if (!response.ok) {
      return { error: `Registry responded ${response.status}` };
    }
    const data = (await response.json()) as { version?: string };
    if (!data.version || typeof data.version !== 'string') {
      return { error: 'Registry response missing version field' };
    }
    return { version: data.version };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }
}

/**
 * Compare current version against latest from the registry.
 * Always succeeds (never throws) — error states surface in the result.
 */
export async function checkForUpdate(
  fetcher: typeof fetch = fetch,
  registryUrl?: string,
): Promise<UpdateCheckResult> {
  const currentVersion = getCurrentVersion();
  const latest = await fetchLatestVersion(fetcher, registryUrl);

  if ('error' in latest) {
    return {
      currentVersion,
      latestVersion: currentVersion,
      updateAvailable: false,
      error: latest.error,
    };
  }

  const cmp = compareSemver(currentVersion, latest.version);
  return {
    currentVersion,
    latestVersion: latest.version,
    updateAvailable: cmp < 0,
  };
}

/**
 * Spawn `npm install -g <package>@latest` and stream output.
 * Injectable `executor` for tests.
 */
export async function performUpdate(
  packageName = 'zelari-coder',
  executor: typeof spawn = spawn,
): Promise<UpdatePerformResult> {
  return new Promise((resolve) => {
    const args = ['install', '-g', `${packageName}@latest`];
    let stdout = '';
    let stderr = '';

    const child = executor('npm', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      resolve({
        ok: false,
        output: stdout + stderr,
        error: err.message,
        exitCode: null,
      });
    });

    child.on('close', (code) => {
      const ok = code === 0;
      resolve({
        ok,
        output: stdout + stderr,
        error: ok ? undefined : `npm exited with code ${code}`,
        exitCode: code,
      });
    });
  });
}