/**
 * updater — npm registry self-update mechanism for zelari-code.
 *
 * Functions:
 *   - getCurrentVersion(): reads bundled package.json
 *   - checkForUpdate(): fetches https://registry.npmjs.org/zelari-code/latest,
 *     compares semver, returns { currentVersion, latestVersion, updateAvailable }
 *   - performUpdate(): spawns `npm install -g zelari-code@latest`,
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
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCmdLine } from './utils/cmdline.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Locate the `npm-cli.js` that ships with the Node runtime currently
 * executing zelari-code (`process.execPath`).
 *
 * Why: on Windows, `/update` spawns `npm` through a shell, which resolves
 * `npm.cmd` off PATH. When Node/npm is managed by a shim tool (Volta,
 * nvm-windows, fnm) and that shim is broken, the spawn dies with exit 127
 * and a message like "Shim target not found: npm.cmd" — the update never
 * runs. npm is bundled *alongside* every Node install, so invoking
 * `node <npm-cli.js> install -g ...` runs the exact npm that matches the
 * running Node while side-stepping the broken `.cmd`/shim layer entirely.
 *
 * Returns the absolute path to npm-cli.js, or null if it can't be found
 * next to `process.execPath` (in which case callers fall back to the
 * PATH-resolved `npm`).
 *
 * @param execPath override for tests (defaults to `process.execPath`)
 */
export function resolveBundledNpmCli(execPath: string = process.execPath): string | null {
  const dir = path.dirname(execPath);
  const candidates = [
    // Windows: C:\...\node.exe → C:\...\node_modules\npm\bin\npm-cli.js
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // POSIX: <prefix>/bin/node → <prefix>/lib/node_modules/npm/bin/npm-cli.js
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // Unreadable path — try the next candidate.
    }
  }
  return null;
}

/**
 * True when an `npm` invocation failed in a way that looks like a broken
 * bin shim / shim manager (Volta, nvm-windows, fnm) rather than a real npm
 * error. These are the failures the bundled-npm fallback can recover from.
 */
export function looksLikeBrokenShim(exitCode: number | null, output: string): boolean {
  if (exitCode === 127) return true;
  const h = output.toLowerCase();
  return h.includes('shim target not found') || h.includes('is not recognized');
}

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
export const REGISTRY_URL = 'https://registry.npmjs.org/zelari-code/latest';

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
 *
 * On Windows, `spawn('npm', ...)` fails with ENOENT because npm is a .cmd
 * shim — a shell is required to resolve the extension. v0.7.9: the win32
 * path passes a single pre-quoted command STRING (args array + shell:true
 * is deprecated, DEP0190: args concatenated unescaped).
 */
export async function performUpdate(
  packageName = 'zelari-code',
  executor: typeof spawn = spawn,
  resolveNpmCli: (execPath?: string) => string | null = resolveBundledNpmCli,
): Promise<UpdatePerformResult> {
  const args = ['install', '-g', `${packageName}@latest`];

  // Attempt 1: the PATH-resolved `npm` (shell on Windows for the .cmd shim).
  const primary = await runNpm(executor, args, 'shim');
  if (primary.ok) return primary;

  // Attempt 2 (fallback): if attempt 1 died like a broken bin shim / shim
  // manager (Volta "Shim target not found: npm.cmd", exit 127), retry with
  // the npm bundled next to the running Node, invoked as
  // `node <npm-cli.js> ...` — no shell, no `.cmd`, no shim in the way.
  const npmCli = resolveNpmCli();
  if (npmCli && looksLikeBrokenShim(primary.exitCode, primary.output)) {
    const fallback = await runNpm(executor, args, 'bundled', npmCli);
    return {
      ...fallback,
      output:
        `[update] npm shim failed (${primary.error ?? 'exit ' + primary.exitCode}); ` +
        `retried via bundled npm (${npmCli}).\n${fallback.output}`,
    };
  }

  return primary;
}

/**
 * Spawn a single npm invocation and collect its result.
 *
 * `mode: 'shim'` runs the PATH-resolved `npm` (shell on Windows so the
 * `.cmd` extension resolves). `mode: 'bundled'` runs
 * `node <npmCliPath> ...` directly, bypassing any bin shim.
 */
function runNpm(
  executor: typeof spawn,
  args: readonly string[],
  mode: 'shim' | 'bundled',
  npmCliPath?: string,
): Promise<UpdatePerformResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const stdio: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe'];

    const child =
      mode === 'bundled' && npmCliPath
        ? executor(process.execPath, [npmCliPath, ...args], { stdio })
        : process.platform === 'win32'
          ? executor(buildCmdLine('npm', args), { stdio, shell: true })
          : executor('npm', args as string[], { stdio });

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