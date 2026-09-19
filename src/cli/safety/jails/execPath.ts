/**
 * jails/execPath — executable lookup by PATH scan + fs.access (t116).
 *
 * WHY: resolving a binary used to mean spawning `which` / `where`. That costs
 * a process per probe (and on win32 a shell-less `where.exe` round trip), it
 * needs the lookup tool itself to exist, and it hands the jail a reason to
 * spawn before the jail decision has been made. A PATH scan with `fs.access`
 * answers the same question synchronously, in-process, with no child.
 *
 * Semantics match what the spawned helpers returned:
 *   - first PATH entry wins (search order is the caller's PATH order);
 *   - POSIX requires the executable bit (`X_OK`);
 *   - win32 does not have a meaningful X_OK, so existence (`F_OK`) is the
 *     test and `PATHEXT` supplies the candidate extensions in ITS order
 *     (upper-case entry first, then lower-case, then the bare name) — the
 *     same order `where` reports.
 *   - a name that already contains a path separator is probed directly and
 *     NEVER searched on PATH (no `./lolbin` hijack through PATH entries).
 *
 * Total: every filesystem error (ENOENT, EACCES, EINVAL on win32, invalid
 * characters) means "not this candidate", never a throw. No spawn lives here
 * (the jails/* rule — see scripts/verify-os-jail.mjs); the injectable
 * `isExecutable` seam keeps the search order testable without a real disk.
 */
import { accessSync, constants as fsConstants } from 'node:fs';
import { pathEntries } from './baseEnv.js';

/** Default win32 extension search order when PATHEXT is unset. */
export const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

export interface ExecLookupOptions {
  /** Environment providing PATH (and PATHEXT on win32). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Platform semantics to apply. Defaults to process.platform. */
  platform?: string;
  /** win32 executable extensions, `;`-separated. Defaults to env.PATHEXT. */
  pathExt?: string;
  /** Test seam: "is this absolute candidate runnable?". Defaults to fs.access. */
  isExecutable?: (candidate: string) => boolean;
}

/** fs.access based default: X_OK on POSIX, existence on win32. */
function defaultIsExecutable(platform: string): (candidate: string) => boolean {
  const mode = platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
  return (candidate: string) => {
    try {
      accessSync(candidate, mode);
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * Join with the separator of the PLATFORM under probe (never `path.join`,
 * which is host-flavoured: on a POSIX host it would emit `/b\bwrap` for a
 * win32 PATH and vice versa). Trailing separators on the directory are
 * dropped so `C:\bin\` + `x.EXE` never doubles the separator.
 */
function joinFor(dir: string, name: string, platform: string): string {
  return platform === 'win32'
    ? `${dir.replace(/[\\/]+$/, '')}\\${name}`
    : `${dir.replace(/\/+$/, '')}/${name}`;
}

/** Last path segment, honoring both separators (host-agnostic). */
function baseNameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** win32 candidate names for one base (PATHEXT order); [base] elsewhere. */
function candidatesFor(base: string, platform: string, pathExt: string | undefined): string[] {
  if (platform !== 'win32') return [base];
  const exts = (pathExt ?? DEFAULT_PATHEXT)
    .split(';')
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  const out: string[] = [];
  if (baseNameOf(base).includes('.')) out.push(base);
  for (const ext of exts) {
    out.push(`${base}${ext}`);
    out.push(`${base}${ext.toLowerCase()}`);
  }
  if (!out.includes(base)) out.push(base);
  return out;
}

/** Env key lookup that honors the case-insensitive win32 environment. */
function envValue(env: NodeJS.ProcessEnv, key: string, platform: string): string | undefined {
  if (platform !== 'win32') return env[key];
  const target = key.toLowerCase();
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

/**
 * Resolve `name` to a runnable path, or null when nothing on PATH matches.
 * Never spawns anything, never throws.
 */
export function resolveExecutable(name: string, opts: ExecLookupOptions = {}): string | null {
  if (typeof name !== 'string' || name.trim().length === 0) return null;
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const isExecutable = opts.isExecutable ?? defaultIsExecutable(platform);
  const trimmed = name.trim();
  const pathExt = opts.pathExt ?? envValue(env, 'PATHEXT', platform);

  // Explicit path (absolute or with a separator): probe it as-is, no PATH.
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return candidatesFor(trimmed, platform, pathExt).find((c) => isExecutable(c)) ?? null;
  }

  for (const dir of pathEntries(envValue(env, 'PATH', platform), platform)) {
    for (const candidate of candidatesFor(joinFor(dir, trimmed, platform), platform, pathExt)) {
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/** True when `name` resolves through PATH (thin readability wrapper). */
export function executableExists(name: string, opts: ExecLookupOptions = {}): boolean {
  return resolveExecutable(name, opts) !== null;
}
