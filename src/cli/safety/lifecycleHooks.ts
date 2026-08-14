/**
 * lifecycleHooks.ts — CLI wiring for the core LifecycleHookRunner (v1.32.0).
 *
 * Loads hook definitions from:
 *   1. `~/.zelari-code/hooks/*.json`  — user-global, ALWAYS active
 *   2. `<project>/.zelari/hooks/*.json` — project-scoped, active ONLY when
 *      the folder is trusted (FolderTrustStore)
 *
 * The runner itself is fail-open: hook crashes/timeouts log and allow the
 * tool; only an explicit `{ "decision": "deny", "reason" }` blocks it.
 *
 * @since v1.32.0
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { LifecycleHookRunner } from '@zelari/core/harness';
import { isFolderTrusted } from './folderTrust.js';

/** ~/.zelari-code/hooks — user-global hooks (always active). */
export function globalHooksDir(): string {
  return join(homedir(), '.zelari-code', 'hooks');
}

/** <project>/.zelari/hooks — project hooks (trusted folders only). */
export function projectHooksDir(projectRoot: string): string {
  return join(projectRoot, '.zelari', 'hooks');
}

/**
 * Create the runner with the standard dir layout:
 * global hooks always; project hooks only when `projectRoot` is trusted.
 *
 * v1.35: this runs on every user turn and used to re-stat both hook dirs
 * with sync fs calls each time. Hook definitions change rarely, so the
 * built runner is cached per dir-pair for a short window (staleness bound
 * = TTL). Single-slot cache: the CLI runs with one cwd per process.
 */
const RUNNER_CACHE_TTL_MS = 30_000;
let runnerCache: { key: string; runner: LifecycleHookRunner; expiresAt: number } | null = null;

export function createDefaultLifecycleHooks(
  projectRoot: string = process.cwd(),
): LifecycleHookRunner {
  const dirs = [globalHooksDir()];
  if (isFolderTrusted(projectRoot)) {
    dirs.push(projectHooksDir(projectRoot));
  }
  const key = dirs.join('\0');
  const now = Date.now();
  if (runnerCache && runnerCache.key === key && runnerCache.expiresAt > now) {
    return runnerCache.runner;
  }
  const runner = new LifecycleHookRunner();
  for (const dir of dirs) {
    runner.loadDir(dir);
  }
  runnerCache = { key, runner, expiresAt: now + RUNNER_CACHE_TTL_MS };
  return runner;
}

/** Drop the cached runner (tests + /hooks reload flows). */
export function resetLifecycleHookCache(): void {
  runnerCache = null;
}

/**
 * Describe hook sources for /inspect: each dir + whether it is active
 * (global always; project only when trusted).
 */
export function describeHookSources(projectRoot: string = process.cwd()): Array<{
  path: string;
  scope: 'global' | 'project';
  active: boolean;
}> {
  const trusted = isFolderTrusted(projectRoot);
  return [
    { path: globalHooksDir(), scope: 'global', active: true },
    { path: projectHooksDir(projectRoot), scope: 'project', active: trusted },
  ];
}
