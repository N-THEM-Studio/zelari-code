/**
 * fixPath.ts — `zelari-code --fix-path` runtime PATH repair.
 *
 * Companion to the install-time auto-fix in `scripts/postinstall.mjs`
 * (`repairWindowsPath`). Use cases:
 *   - The user's PATH was reset AFTER install (corporate GPO, manual edit,
 *     profile script overwrite) — postinstall can't help retroactively.
 *   - The install ran as a different user / SYSTEM and the User-scope write
 *     landed in the wrong hive.
 *   - Quick first-aid when `zelari-code` is reachable from one shell
 *     (e.g. Git Bash, which re-reads PATH) but not another (PowerShell,
 *     which caches the registry value at session start).
 *
 * Contract mirrors `repairWindowsPath` exactly:
 *   - Windows only; POSIX prints an advisory message and exits 0 (no-op).
 *   - Scope "User" (HKCU), never "Machine" — no admin prompt, no GPO risk.
 *   - Read current value via [Environment]::GetEnvironmentVariable('Path','User'),
 *     write via SetEnvironmentVariable(...,'User'). Avoids `setx` (truncates
 *     at 1024 chars) and `reg.exe` (fragile REG_EXPAND_SZ parsing).
 *   - Idempotent: if the prefix is already an exact PATH entry, no write.
 *   - Never throws.
 *
 * Exit codes (from the dispatcher in main.ts):
 *   0 — prefix was already present, OR was successfully appended
 *   1 — could not detect prefix, OR write failed
 *
 * @see scripts/postinstall.mjs — install-time auto-fix (same logic, silent)
 * @see src/cli/utils/doctor.ts — `checkPath()` points users here on failure
 */

import { spawnSync } from "node:child_process";

/** Result returned to the dispatcher for exit-code + display decisions. */
export type FixPathResult =
  | { ok: true; alreadyOk: boolean; prefix: string }
  | { ok: false; prefix: string; error: string };

/** Resolve the npm global prefix. Empty string on failure. */
function getGlobalPrefix(): string {
  return (
    (
      process.env.npm_config_prefix ||
      process.env.NPM_CONFIG_PREFIX ||
      ""
    ).trim() ||
    (() => {
      try {
        return spawnSync("npm", ["prefix", "-g"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).stdout?.trim() ?? "";
      } catch {
        return "";
      }
    })()
  );
}

/** Run a PowerShell one-liner, return trimmed stdout or "" on failure. */
function powershell(script: string): string {
  try {
    const res = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8" },
    );
    if (res.status === 0) return (res.stdout || "").trim();
    return "";
  } catch {
    return "";
  }
}

/**
 * Ensure the npm global prefix is on the Windows user PATH.
 *
 * Safe to call on any platform: returns `{ ok: false, error }` on POSIX
 * with an actionable message. The dispatcher decides whether to exit 0/1
 * based on `ok`.
 */
export function repairWindowsUserPath(): FixPathResult {
  const prefix = getGlobalPrefix();
  if (!prefix) {
    return {
      ok: false,
      prefix: "",
      error: "could not detect the npm global prefix (run inside an npm context, or set npm_config_prefix)",
    };
  }

  // POSIX: no registry equivalent; advisory no-op. The user must edit their
  // shell profile (.bashrc/.zshrc) — there is no cross-shell auto-fix.
  if (process.platform !== "win32") {
    return {
      ok: false,
      prefix,
      error: `--fix-path is Windows-only. On ${process.platform}, add to your shell profile:\n  export PATH="${prefix}/bin:$PATH"`,
    };
  }

  const userPath = powershell(
    "[Environment]::GetEnvironmentVariable('Path','User')",
  );

  // Exact-entry match: split by ';', normalize (lowercase, forward→back
  // slashes, trim trailing separators), compare. Avoids the substring trap
  // where prefix "C:\\npm" would falsely match entry "C:\\npm-cache".
  const norm = (p: string): string =>
    p.toLowerCase().replace(/\/+/g, "\\").replace(/\\+$/, "");
  const entries = userPath
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean);
  if (entries.some((e) => norm(e) === norm(prefix))) {
    return { ok: true, alreadyOk: true, prefix };
  }

  // Append and write back to User scope.
  const updated = userPath === "" || userPath.endsWith(";")
    ? `${userPath}${prefix}`
    : `${userPath};${prefix}`;
  const writeRes = powershell(
    `[Environment]::SetEnvironmentVariable('Path', ${JSON.stringify(updated)}, 'User')`,
  );
  // SetEnvironmentVariable returns no stdout on success; the only signal we
  // get is exit status, which powershell() collapses to "" on non-zero.
  // Re-read to confirm: if the prefix is now present, the write worked
  // even if we couldn't observe the exit code directly.
  const reread = powershell(
    "[Environment]::GetEnvironmentVariable('Path','User')",
  );
  const rereadEntries = reread.split(";").map((e) => e.trim()).filter(Boolean);
  if (rereadEntries.some((e) => norm(e) === norm(prefix))) {
    return { ok: true, alreadyOk: false, prefix };
  }
  return {
    ok: false,
    prefix,
    error: writeRes === null && reread === userPath
      ? "PowerShell write did not take effect (permission denied? run as the same user that owns the install)"
      : "PATH write failed for an unknown reason",
  };
}
