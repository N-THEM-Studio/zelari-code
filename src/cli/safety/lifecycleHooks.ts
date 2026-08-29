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
 * v2.16 (HARNESS-10 t22): strict surfaces (headless/mission/CI — see
 * policyLoadMode) build the runner FAIL-CLOSED instead, so a hook that
 * crashes / times out / returns invalid JSON / denies without reason denies
 * the tool call with reason 'hook-failed'. `ZELARI_HOOKS_FAILURE` =
 * fail-open|fail-closed overrides; anything else falls through to the
 * active policy load mode (same resolver semantics, no second switch).
 *
 * @since v1.32.0
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { LifecycleHookRunner, type HookFailureMode } from '@zelari/core/harness';
import { isFolderTrusted } from './folderTrust.js';
import { activePolicyLoadMode } from './policyLoadMode.js';

/** ~/.zelari-code/hooks — user-global hooks (always active). */
export function globalHooksDir(): string {
  return join(homedir(), '.zelari-code', 'hooks');
}

/** <project>/.zelari/hooks — project hooks (trusted folders only). */
export function projectHooksDir(projectRoot: string): string {
  return join(projectRoot, '.zelari', 'hooks');
}

/** Env override for hook failure semantics (v2.16 t22). */
export const HOOKS_FAILURE_ENV = 'ZELARI_HOOKS_FAILURE';

/**
 * v2.16 (HARNESS-10 t22): resolve the runner failureMode the SAME way the
 * policy loader resolves strictness — not a second switch with different
 * semantics. `ZELARI_HOOKS_FAILURE` wins when set to exactly `fail-open` /
 * `fail-closed` (case/space-insensitive); any other value is IGNORED and
 * falls through to the active policy load mode (strict ⇒ fail-closed,
 * permissive ⇒ fail-open; the TUI stays fail-open). Pure: `env` is
 * injectable so tests never mutate process.env.
 */
export function resolveHookFailureMode(
  override: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): HookFailureMode {
  const v = override?.trim().toLowerCase();
  if (v === 'fail-closed') return 'fail-closed';
  if (v === 'fail-open') return 'fail-open';
  return activePolicyLoadMode(env) === 'strict' ? 'fail-closed' : 'fail-open';
}

/**
 * Snapshot hook dirs so we reload only when a `*.json` file is added,
 * removed, or rewritten. Directory mtime alone misses in-place edits on
 * Windows; per-file mtime+size is cheap compared to re-reading contents.
 */
export function fingerprintHookDirs(dirs: readonly string[]): string {
  const parts: string[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    } catch {
      parts.push(`${dir}:missing`);
      continue;
    }
    if (names.length === 0) {
      try {
        parts.push(`${dir}:empty:${statSync(dir).mtimeMs}`);
      } catch {
        parts.push(`${dir}:empty`);
      }
      continue;
    }
    for (const name of names) {
      const full = join(dir, name);
      try {
        const st = statSync(full);
        parts.push(`${full}:${st.mtimeMs}:${st.size}`);
      } catch {
        parts.push(`${full}:gone`);
      }
    }
  }
  return parts.join('\0');
}

/**
 * Create the runner with the standard dir layout:
 * global hooks always; project hooks only when `projectRoot` is trusted.
 *
 * v1.35: this runs on every user turn and used to readdir+readFile both
 * hook dirs with sync fs each time. The built runner is cached until the
 * hook-file fingerprint changes. Single-slot cache: one cwd per process.
 */
let runnerCache: { fingerprint: string; runner: LifecycleHookRunner } | null = null;

/** Build (or reuse) a runner from an explicit dir list. Exported for tests. */
export function createLifecycleHooksFromDirs(dirs: readonly string[]): LifecycleHookRunner {
  // t22: the failure mode is part of the cache key so an env/surface change
  // rebuilds the runner instead of serving a stale-mode one.
  const failureMode = resolveHookFailureMode(process.env[HOOKS_FAILURE_ENV]);
  const fingerprint = fingerprintHookDirs(dirs);
  const cacheKey = `${fingerprint}\0${failureMode}`;
  if (runnerCache && runnerCache.fingerprint === cacheKey) {
    return runnerCache.runner;
  }
  const runner = new LifecycleHookRunner({ failureMode });
  for (const dir of dirs) {
    runner.loadDir(dir);
  }
  runnerCache = { fingerprint: cacheKey, runner };
  return runner;
}

export function createDefaultLifecycleHooks(
  projectRoot: string = process.cwd(),
): LifecycleHookRunner {
  const dirs = [globalHooksDir()];
  if (isFolderTrusted(projectRoot)) {
    dirs.push(projectHooksDir(projectRoot));
  }
  return createLifecycleHooksFromDirs(dirs);
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
