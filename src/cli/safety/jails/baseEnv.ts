/**
 * jails/baseEnv — deny-first environment for a jailed child (t116).
 *
 * WHY: `sanitizeEnv(spec.envAllowlist)` narrowed the child env to the spec
 * allowlist, but `spec.envAllowlist` is built from BASE_ENV_ALLOWLIST /
 * WIN32_ENV_ALLOWLIST in osJail — a SET that grows by accretion (each new
 * shell quirk adds a variable). That is a allow-first posture: every new
 * variable added to the spec list automatically reaches the child.
 *
 * This module flips the posture to DENY-FIRST: a jailed child receives ONLY
 * the variables a shell/toolchain actually needs to boot, and anything else
 * (tokens, credentials, cloud CLI state, ZELARI_* secrets, CI vendor vars) is
 * dropped even if a caller widens the spec allowlist. The two filters are
 * applied in series (base env first, then the spec allowlist) so the result
 * can only ever be NARROWER than before.
 *
 * ESCAPE HATCH: `ZELARI_JAIL_FULL_ENV=1` restores today's behaviour (the full
 * merged env) for operators whose jailed toolchain needs an exotic variable.
 * It is an explicit opt-in read from the SAME env being narrowed, never a
 * default, and it is never honored implicitly by a typo (`'1'` only).
 *
 * Pure and total: `env` is never mutated, an unreadable process.env cannot
 * throw. No child process is ever spawned here (the jails/* rule: argv/env
 * assembly only — see scripts/verify-os-jail.mjs).
 */

/** Env var that restores the full inherited environment inside the jail. */
export const JAIL_FULL_ENV_ENV = 'ZELARI_JAIL_FULL_ENV';

/**
 * Minimal host-agnostic allowlist. Every entry is required to start a shell
 * or a Node/npm toolchain: PATH/HOME to resolve and configure, LANG/TERM to
 * render, TMP* to write scratch files. CI and NO_COLOR are kept because the
 * CLI's own fail-fast flag and TUI palette depend on them (dropping CI would
 * silently disable the fast-fail it propagates on purpose).
 */
export const BASE_JAIL_ENV_KEYS: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'CI',
  'NO_COLOR',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
];

/**
 * win32 additions without which no child process can start at all
 * (SystemRoot/SystemDrive), no shell can be located (ComSpec, PATHEXT), and
 * no user profile is resolvable (USERPROFILE/USERNAME/USERDOMAIN, APPDATA,
 * LOCALAPPDATA, PROGRAMDATA, WINDIR). Kept in lockstep with
 * osJail.WIN32_ENV_ALLOWLIST so the deny-first pass never drops something the
 * spec pass already documented as boot-critical.
 */
export const WIN32_BASE_JAIL_ENV_KEYS: readonly string[] = [
  'USERPROFILE',
  'USERNAME',
  'USERDOMAIN',
  'HOMEDRIVE',
  'HOMEPATH',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'WINDIR',
  'MSYSTEM',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
];

/** The allowlist for a platform (win32 adds the boot-critical keys). */
export function baseJailEnvKeys(platform: string = process.platform): readonly string[] {
  return platform === 'win32'
    ? [...BASE_JAIL_ENV_KEYS, ...WIN32_BASE_JAIL_ENV_KEYS]
    : BASE_JAIL_ENV_KEYS;
}

/** `LC_ALL`, `LC_CTYPE`, `LC_MESSAGES`, … — locale must survive the filter. */
function isLocaleKey(upperKey: string): boolean {
  return upperKey === 'LC_ALL' || upperKey.startsWith('LC_');
}

/** True when the operator explicitly asked for the full inherited env. */
export function jailFullEnvRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[JAIL_FULL_ENV_ENV]?.trim() === '1';
}

/**
 * Deny-first narrowing. Returns a NEW object holding only allowlisted keys
 * (case-insensitive on win32, original casing preserved) plus every LC_* key.
 * `full: true` (or `ZELARI_JAIL_FULL_ENV=1` in `env`) returns a plain copy of
 * the input — the documented escape hatch, identical to pre-t116 behaviour.
 */
export function baseJailEnv(
  env: NodeJS.ProcessEnv,
  opts: { platform?: string; full?: boolean } = {},
): NodeJS.ProcessEnv {
  const platform = opts.platform ?? process.platform;
  if (opts.full ?? jailFullEnvRequested(env)) {
    const copy: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(env)) if (v !== undefined) copy[k] = v;
    return copy;
  }
  const fold = platform === 'win32';
  const wanted = new Set(baseJailEnvKeys(platform).map((k) => (fold ? k.toLowerCase() : k)));
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    const upper = k.toUpperCase();
    const key = fold ? k.toLowerCase() : k;
    if (wanted.has(key) || isLocaleKey(upper)) out[k] = v;
  }
  return out;
}

/**
 * PATH entries for a platform (`;` on win32, `:` elsewhere) with empty entries
 * dropped. Deliberately NOT `path.delimiter`: the lookup must follow the
 * PLATFORM being probed, not the host running the probe (pure tests pass
 * `platform: 'win32'` on a POSIX runner, and `C:\bin;D:\tools` must survive).
 */
export function pathEntries(pathValue: string | undefined, platform: string = process.platform): string[] {
  if (!pathValue) return [];
  const sep = platform === 'win32' ? ';' : ':';
  return pathValue
    .split(sep)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}
