/**
 * plugins/installer — spawn `npm install` for a plugin, buffered.
 *
 * Mirrors updater.ts:performUpdate (the self-update install path) with two
 * differences:
 *   1. The install scope is per-plugin: `-D` (project-local) for linters +
 *      Playwright (that's how diagnostics/engine.ts + browser/driver.ts
 *      resolve them via node_modules/.bin / dynamic import), `-g` (global)
 *      for LSP servers (cross-project dev tools).
 *   2. No `@latest` pinning — plugins don't self-update, so we install
 *      whatever npm resolves as current.
 *
 * Everything else is identical and reuses the updater's hard-won platform
 * handling: buildCmdLine + shell:true on win32 for the `.cmd` shim, and the
 * broken-shim fallback to the npm bundled next to Node (rescues
 * Volta/nvm-windows/fnm where the global npm shim is broken).
 *
 * Output is BUFFERED (stdout+stderr concatenated), surfaced as a single
 * string after exit — same UX as /update. This keeps the install gate simple
 * (no streaming-log component needed) and matches the house style.
 *
 * Contract: never throws. Errors → { ok: false, error }.
 *
 * @see src/cli/updater.ts — performUpdate / runNpm, the template this mirrors
 * @see src/cli/utils/cmdline.ts — buildCmdLine (win32 DEP0190-safe quoting)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { buildCmdLine } from '../utils/cmdline.js';
import {
  resolveBundledNpmCli,
  looksLikeBrokenShim,
} from '../updater.js';
import type { PluginSpec } from './registry.js';

export interface InstallResult {
  ok: boolean;
  /** Combined stdout + stderr. Empty on a spawn-level failure. */
  output: string;
  /** npm exit code, or null if the process never started / errored. */
  exitCode: number | null;
  /** Present only when something went wrong (spawn error, non-zero exit). */
  error?: string;
}

/**
 * Install a plugin via npm. Respects PluginSpec.installScope (-D vs -g).
 *
 * @param spec     The plugin to install.
 * @param cwd      Working directory (matters for -D installs; ignored by -g
 *                 except as the spawn cwd).
 * @param executor Injected spawn (tests). Defaults to node:child_process.spawn.
 */
export async function installPlugin(
  spec: PluginSpec,
  cwd: string,
  executor: typeof spawn = spawn,
): Promise<InstallResult> {
  const scopeFlag = spec.installScope === 'global' ? '-g' : '-D';
  const args = ['install', scopeFlag, spec.npmPackage];

  // Attempt 1: PATH-resolved npm (shell on win32 for the .cmd shim).
  let result = await runNpm(executor, args, cwd, 'shim');

  // Attempt 2: if attempt 1 died like a broken bin shim (Volta/nvm/fnm),
  // retry via the npm bundled with Node. No shell, no .cmd in the way.
  if (!result.ok) {
    const npmCli = resolveBundledNpmCli();
    if (npmCli && looksLikeBrokenShim(result.exitCode, result.output)) {
      const fallback = await runNpm(executor, args, cwd, 'bundled', npmCli);
      result = {
        ...fallback,
        output:
          `[plugins] npm shim failed (${result.error ?? 'exit ' + result.exitCode}); ` +
          `retried via bundled npm (${npmCli}).\n${fallback.output}`,
      };
    }
  }

  if (!result.ok) return result;

  // Playwright needs a second step: download Chromium (~150 MB). Without it,
  // browser_check still fails with "Executable doesn't exist".
  if (spec.id === 'playwright') {
    const browsers = await runPlaywrightInstallChromium(cwd, executor);
    result = {
      ...result,
      ok: browsers.ok ? true : result.ok,
      // Prefer package success even if browser download fails — surface both.
      output:
        (result.output ? result.output + '\n' : '') +
        (browsers.output ? `[playwright browsers]\n${browsers.output}` : '') +
        (browsers.ok
          ? ''
          : `\n[playwright] Chromium install failed: ${browsers.error ?? 'unknown'}. ` +
            `Run: npx playwright install chromium`),
      error: browsers.ok
        ? result.error
        : result.error ??
          `playwright package installed but Chromium download failed: ${browsers.error ?? 'unknown'}`,
    };
    // Package is usable for import even if browser download failed — keep ok
    // true so the gate advances; browser_check will print a clear error.
    result = { ...result, ok: true };
  }

  return result;
}

/**
 * `npx playwright install chromium` in the project cwd (after npm i -D playwright).
 */
function runPlaywrightInstallChromium(
  cwd: string,
  executor: typeof spawn,
): Promise<InstallResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const stdio: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe'];
    const args = ['playwright', 'install', 'chromium'];
    const child: ChildProcess =
      process.platform === 'win32'
        ? executor(buildCmdLine('npx', args), { stdio, shell: true, cwd })
        : executor('npx', args, { stdio, cwd });

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
        exitCode: code,
        error: ok ? undefined : `npx playwright install chromium exited ${code}`,
      });
    });
  });
}

/**
 * Spawn one npm invocation and collect its buffered result.
 *
 * `mode: 'shim'` runs the PATH-resolved `npm` (shell on Windows for `.cmd`).
 * `mode: 'bundled'` runs `node <npmCliPath> ...` directly, bypassing shims.
 *
 * Direct copy of updater.ts:runNpm with cwd threaded through. Keeping the two
 * in lockstep means platform fixes (DEP0190, broken-shim detection) apply to
 * both — diverging would let one rot while the other gets fixed.
 */
function runNpm(
  executor: typeof spawn,
  args: readonly string[],
  cwd: string,
  mode: 'shim' | 'bundled',
  npmCliPath?: string,
): Promise<InstallResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const stdio: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe'];

    const child: ChildProcess =
      mode === 'bundled' && npmCliPath
        ? executor(process.execPath, [npmCliPath, ...args], { stdio, cwd })
        : process.platform === 'win32'
          ? executor(buildCmdLine('npm', args), { stdio, shell: true, cwd })
          : executor('npm', args as string[], { stdio, cwd });

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
        exitCode: code,
        error: ok ? undefined : `npm exited with code ${code}`,
      });
    });
  });
}
