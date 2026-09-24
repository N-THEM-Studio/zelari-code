/**
 * windowsProgram — what `exec_process` can actually spawn on Windows.
 *
 * exec_process spawns program + argv WITHOUT a shell. On Windows `npm` and
 * `npx` are `.cmd` shims, which Node refuses to spawn without a shell
 * (ENOENT for the bare name, EINVAL for `npm.cmd` since the 2024 batch-file
 * hardening). In the 2026-09 sessions that was 22 of exec_process's 28
 * errors — each one a wasted model turn.
 *
 * - `npm` / `npx` are rewritten to what the shim itself runs:
 *   `node <npm>/bin/npm-cli.js …` — still no shell, same argv.
 * - any other `.cmd` / `.bat` is reported before spawning, with the fix
 *   (use the bash tool), instead of a bare ENOENT/EINVAL.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

export type WindowsProgramResolution =
  | { kind: 'direct' }
  | { kind: 'node-script'; program: string; argv: string[] }
  | { kind: 'shim'; path: string };

export interface WindowsProgramDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  execPath: string;
  exists: (p: string) => boolean;
}

const NPM_STEMS = new Set(['npm', 'npx']);
const SHIM_EXT = /\.(cmd|bat)$/i;

function pathDirs(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATH ?? env.Path ?? '';
  return raw.split(';').map((d) => d.trim()).filter(Boolean);
}

/** First PATH hit for a bare name, honouring PATHEXT order (.COM;.EXE;.BAT;.CMD). */
function whichWindows(stem: string, deps: WindowsProgramDeps): string | null {
  const exts = (deps.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of pathDirs(deps.env)) {
    for (const ext of exts) {
      const candidate = path.win32.join(dir, stem + ext.toLowerCase());
      if (deps.exists(candidate)) return candidate;
    }
  }
  return null;
}

export function resolveWindowsProgram(
  program: string,
  argv: readonly string[],
  deps: WindowsProgramDeps = {
    platform: process.platform,
    env: process.env,
    execPath: process.execPath,
    exists: existsSync,
  },
): WindowsProgramResolution {
  if (deps.platform !== 'win32') return { kind: 'direct' };
  const base = path.win32.basename(program);
  const stem = base.replace(/\.(cmd|bat|exe)$/i, '').toLowerCase();

  if (NPM_STEMS.has(stem)) {
    // Node's own install dir first (npm ships beside node.exe), then any PATH
    // dir holding the shim (nvm-style layouts keep node_modules/npm there too).
    const dirs = [path.win32.dirname(deps.execPath)];
    for (const dir of pathDirs(deps.env)) {
      if (deps.exists(path.win32.join(dir, `${stem}.cmd`))) dirs.push(dir);
    }
    for (const dir of dirs) {
      const cli = path.win32.join(dir, 'node_modules', 'npm', 'bin', `${stem}-cli.js`);
      if (deps.exists(cli)) return { kind: 'node-script', program: deps.execPath, argv: [cli, ...argv] };
    }
  }

  if (SHIM_EXT.test(base)) return { kind: 'shim', path: program };
  if (path.win32.extname(base) === '' && !path.win32.isAbsolute(program)) {
    const hit = whichWindows(base, deps);
    if (hit && SHIM_EXT.test(hit)) return { kind: 'shim', path: hit };
  }
  return { kind: 'direct' };
}
