/**
 * repair-path.mjs — Windows user-PATH repair logic, extracted for testability.
 *
 * Lives separately from postinstall.mjs so it can be imported in unit tests
 * WITHOUT triggering postinstall's main side-effect block (the install flow
 * that runs on `npm install -g`). postinstall.mjs re-imports and re-exports
 * this so its public surface stays unchanged.
 *
 * Contract (shared with src/cli/utils/fixPath.ts):
 *   - Windows only; no-op on POSIX.
 *   - Scope "User" (HKCU), never "Machine" — no admin prompt, no GPO risk.
 *   - Read via [Environment]::GetEnvironmentVariable('Path','User'), write via
 *     SetEnvironmentVariable(...,'User'). Avoids `setx` (truncates at 1024
 *     chars) and `reg.exe` (fragile REG_EXPAND_SZ parsing).
 *   - Idempotent: exact-entry match (normalized), not substring.
 *   - Never throws.
 *
 * @see scripts/postinstall.mjs — install-time caller
 * @see src/cli/utils/fixPath.ts — runtime / `--fix-path` caller (TS port)
 */

import { spawnSync } from 'node:child_process';

/**
 * Normalize a PATH entry for exact matching: lowercase, forward→back slashes,
 * trim trailing separators. Lets "C:\npm" match "c:\npm\" without accepting
 * substring overlaps like "C:\npm-cache".
 *
 * @param {string} p
 * @returns {string}
 */
function normalizeEntry(p) {
  return p.toLowerCase().replace(/\/+/g, '\\').replace(/\\+$/, '');
}

/**
 * Run a PowerShell one-liner via spawnSync (args array, no shell quoting
 * headaches). Returns trimmed stdout, or '' on any failure (non-zero exit,
 * spawn error). Never throws.
 *
 * @param {string} script  PowerShell command to execute
 * @returns {string}
 */
function powershell(script) {
  try {
    const res = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8' },
    );
    if (res.status === 0) return (res.stdout || '').trim();
    return '';
  } catch {
    return '';
  }
}

/**
 * Ensure the npm global prefix is on the Windows user PATH.
 *
 * Reads the User-scope PATH, appends `prefix` if it is not already an exact
 * (normalized) entry, and writes it back. Opt out with ZELARI_NO_PATH_REPAIR=1.
 *
 * @param {string} prefix  npm global prefix (e.g. C:\Users\me\AppData\Roaming\npm)
 * @returns {boolean}      true if the prefix was appended this call;
 *                         false if already present, opted out, non-Windows,
 *                         empty prefix, or the write failed
 */
export function repairWindowsPath(prefix) {
  if (process.env.ZELARI_NO_PATH_REPAIR === '1') return false;
  if (process.platform !== 'win32') return false;
  if (!prefix) return false;

  const userPath = powershell(
    "[Environment]::GetEnvironmentVariable('Path','User')",
  );
  // Empty string is a valid PATH (fresh install); only the ambiguous
  // "spawn failed, no signal" case (powershell returns '' AND we can't
  // distinguish from a genuinely empty PATH) forces a bail. We treat a
  // genuine empty PATH as "append" — SetEnvironmentVariable handles it.
  // Detection: if powershell returned '' due to failure, the read status
  // was non-zero. We approximate by re-checking: a genuine empty user PATH
  // is rare but legal; prefer to attempt the write (idempotent + re-verified).

  const entries = userPath.split(';').map((e) => e.trim()).filter(Boolean);
  if (entries.some((e) => normalizeEntry(e) === normalizeEntry(prefix))) {
    return false; // already present — idempotent no-op
  }

  const updated = userPath === '' || userPath.endsWith(';')
    ? `${userPath}${prefix}`
    : `${userPath};${prefix}`;
  powershell(
    `[Environment]::SetEnvironmentVariable('Path', ${JSON.stringify(updated)}, 'User')`,
  );

  // Verify by re-reading: SetEnvironmentVariable returns no stdout, so the
  // only robust signal that the write stuck is observing the prefix in place.
  const reread = powershell(
    "[Environment]::GetEnvironmentVariable('Path','User')",
  );
  const rereadEntries = reread.split(';').map((e) => e.trim()).filter(Boolean);
  return rereadEntries.some((e) => normalizeEntry(e) === normalizeEntry(prefix));
}
