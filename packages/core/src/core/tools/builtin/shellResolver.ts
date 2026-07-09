/**
 * shellResolver — v0.7.2 cross-platform shell selection for the `bash` tool.
 *
 * Problem: `spawn(cmd, { shell: true })` on win32 uses cmd.exe (via ComSpec),
 * which breaks npm (needs `npm.cmd`), mis-handles `&&` / quoting, and doesn't
 * understand POSIX commands (`ls`, `which`, `$VAR`). The tool is named `bash`
 * but historically ran cmd.exe on Windows — a misleading and broken state.
 *
 * Resolution: when Git Bash / MSYS2 bash is available, spawn it directly via
 * `spawn(bashPath, ['-c', cmd], { shell: false })` so real POSIX semantics
 * apply. Detection order (most reliable first):
 *
 *   1. `ZELARI_SHELL` env var — explicit user override (the knob that was
 *      missing; lets users point at any shell they want).
 *   2. `SHELL` env var on win32 — set automatically by Git Bash / MSYS2
 *      sessions (e.g. `D:\Git\bin\bash.exe`). The most reliable automatic
 *      signal when the CLI is launched from Git Bash.
 *   3. Standard Git for Windows install paths (probed with existsSync).
 *   4. `where bash` — last-ditch PATH lookup.
 *   5. Fallback: cmd.exe (`shell: true`) with a one-time stderr warning so
 *      the user knows POSIX commands may fail and can install Git for Windows
 *      or set ZELARI_SHELL.
 *
 * On POSIX the resolver is a no-op: `shell: true` already means /bin/sh,
 * which is bash-compatible enough.
 *
 * Idempotent: the resolved shell is memoized per-process. The warning is
 * emitted at most once per process (guarded by a module-level flag).
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export interface ResolvedShell {
  /**
   * The value to pass to `spawn`'s `shell` option, OR a bash binary path to
   * spawn directly via `spawn(path, ['-c', cmd], { shell: false })`.
   *
   * - When `isBash` is true, `shell` is an absolute path string; spawn it
   *   directly with `-c`.
   * - When `isBash` is false, `shell` is `true` (let Node pick cmd.exe on
   *   win32, /bin/sh on POSIX).
   */
  shell: string | true;
  /** Human-readable label for logs / the model, e.g. "bash (D:\\Git\\bin\\bash.exe)". */
  via: string;
  /** True when `shell` is a real bash binary (spawn via `-c`, POSIX semantics). */
  isBash: boolean;
}

/** Standard Git for Windows bash locations (probed in order). */
const STANDARD_BASH_PATHS = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
];

let memoized: ResolvedShell | null = null;
let warnedFallback = false;

/**
 * True when `p` is the Windows Subsystem for Linux bash *launcher*, not Git Bash.
 *
 * `where bash` on a machine without Git for Windows often returns
 * `C:\Windows\System32\bash.exe` (or the WindowsApps stub). That binary enters
 * a Linux distro with a Linux PATH — Windows `node`/`npm` are invisible, so the
 * agent cannot run builds. Never treat WSL as the agent shell.
 *
 * Kept in lockstep with `src/cli/utils/prereqChecks.ts`.
 */
export function isWslBashPath(p: string): boolean {
  if (!p || typeof p !== 'string') return false;
  // Normalize separators + case for win32 path matching.
  const n = p.replace(/\//g, '\\').toLowerCase();
  if (n.includes('\\windows\\system32\\bash.exe')) return true;
  if (n.includes('\\windows\\syswow64\\bash.exe')) return true;
  if (n.includes('\\windowsapps\\bash.exe')) return true;
  return false;
}

/** Accept only a real (non-WSL) bash path that exists on disk. */
function acceptBashPath(p: string | undefined | null): string | null {
  if (!p || p.trim().length === 0) return null;
  const trimmed = p.trim();
  if (isWslBashPath(trimmed)) return null;
  if (!existsSyncSafe(trimmed)) return null;
  return trimmed;
}

/**
 * Resolve the shell to use for command execution. Memoized per-process.
 *
 * @param forceReResolve bypass the memo (for tests).
 */
export function resolveShell(forceReResolve = false): ResolvedShell {
  if (memoized && !forceReResolve) return memoized;

  // POSIX: Node's `shell: true` already uses /bin/sh — no work needed.
  if (process.platform !== 'win32') {
    memoized = { shell: true, via: '/bin/sh', isBash: false };
    return memoized;
  }

  // win32: try to find a real bash.
  const found = resolveBashWindows();
  if (found) {
    memoized = { shell: found, via: `bash (${found})`, isBash: true };
    return memoized;
  }

  // Fallback: cmd.exe. Warn once so the user knows POSIX commands may fail.
  if (!warnedFallback) {
    warnedFallback = true;
    // eslint-disable-next-line no-console
    console.error(
      '[zelari-code] bash tool: Git Bash not found — falling back to cmd.exe. ' +
        'POSIX commands (ls, which, $VAR, &&) may fail. Install Git for Windows ' +
        'or set ZELARI_SHELL to your bash binary for proper POSIX support.',
    );
  }
  memoized = { shell: true, via: 'cmd.exe', isBash: false };
  return memoized;
}

/** Detection chain for a bash binary on win32. Returns the path or null. */
function resolveBashWindows(): string | null {
  // 1. Explicit override (WSL launchers rejected — see isWslBashPath).
  const fromEnv = acceptBashPath(process.env.ZELARI_SHELL);
  if (fromEnv) return fromEnv;

  // 2. SHELL env var (set by Git Bash / MSYS2 sessions).
  const fromSession = acceptBashPath(process.env.SHELL);
  if (fromSession) return fromSession;

  // 3. Standard install paths.
  for (const p of STANDARD_BASH_PATHS) {
    const accepted = acceptBashPath(p);
    if (accepted) return accepted;
  }

  // 4. `where bash` — PATH lookup. `where` ships with Windows (a real .exe,
  // so no shell needed — and shell:true + args array is deprecated, DEP0190).
  // Skip WSL launchers; prefer a later non-WSL hit if any.
  try {
    const result = spawnSync('where', ['bash'], { encoding: 'utf-8', windowsHide: true });
    if (result.status === 0 && result.stdout) {
      for (const line of result.stdout.split(/\r?\n/)) {
        const accepted = acceptBashPath(line);
        if (accepted) return accepted;
      }
    }
  } catch {
    // `where` not available or failed — fall through to null.
  }

  return null;
}

/** existsSync that swallows edge-case errors (e.g. invalid chars on win32). */
function existsSyncSafe(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/** Test-only: reset memo + warning flag. */
export function _resetShellResolverForTests(): void {
  memoized = null;
  warnedFallback = false;
}
