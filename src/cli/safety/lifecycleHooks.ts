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
 */
export function createDefaultLifecycleHooks(
  projectRoot: string = process.cwd(),
): LifecycleHookRunner {
  const runner = new LifecycleHookRunner();
  const dirs = [globalHooksDir()];
  if (isFolderTrusted(projectRoot)) {
    dirs.push(projectHooksDir(projectRoot));
  }
  for (const dir of dirs) {
    runner.loadDir(dir);
  }
  return runner;
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
