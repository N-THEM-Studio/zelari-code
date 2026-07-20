/**
 * fixBudget.ts — `zelari-code --fix-budget` runtime tool-budget repair.
 *
 * Companion to `--fix-path`. Use cases:
 *   - The default tool-loop / context caps are too tight for multi-step
 *     implementations (build + test + smoke + JSON updates) and the agent
 *     gets force-summarized by the hard cap mid-work, then has to rediscover
 *     state on the next turn — a frustrating loop of partial completions.
 *   - The user just installed zelari-code on a fresh machine and wants the
 *     "good" defaults without manually editing environment variables.
 *
 * Contract mirrors `repairWindowsUserPath` in `fixPath.ts`:
 *   - Windows only; POSIX prints an advisory message and exits 0 (no-op).
 *   - Scope "User" (HKCU), never "Machine" — no admin prompt, no GPO risk.
 *   - Read current value via [Environment]::GetEnvironmentVariable(name,'User'),
 *     write via SetEnvironmentVariable(name, value, 'User'). Avoids `setx`
 *     (truncates at 1024 chars).
 *   - Idempotent: variables already set to the target value are skipped.
 *   - Never throws.
 *
 * Exit codes (from the dispatcher in main.ts):
 *   0 — all variables already at target, OR were successfully written
 *   1 — write failed for at least one variable
 *
 * @see src/cli/utils/fixPath.ts — sibling repair command (PATH instead of budget)
 * @see src/cli/utils/doctor.ts — `checkBudget()` points users here on failure
 * @see packages/core/src/core/AgentHarness.ts — where these caps are enforced
 */

import { spawnSync } from "node:child_process";

/**
 * The recommended out-of-the-box tool-loop budget. Values match the raised
 * defaults in AgentHarness.ts / tokenBudget.ts, but as persistent env vars so
 * they survive across upgrades and override any future lowering of the
 * in-code default.
 */
export const RECOMMENDED_BUDGET = {
  ZELARI_MAX_TOOL_LOOP_HARD: "180",
  ZELARI_MAX_TOOL_LOOP_ITERATIONS: "60",
  ZELARI_CONTEXT_LIMIT: "400000",
} as const;

/** Result returned to the dispatcher for exit-code + display decisions. */
export type FixBudgetResult =
  | { ok: true; alreadyOk: boolean; applied: string[]; skipped: string[] }
  | { ok: false; error: string };

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
 * Ensure the recommended ZELARI_* budget variables are set at User scope.
 *
 * Safe to call on any platform: returns `{ ok: false, error }` on POSIX
 * with an actionable message. The dispatcher decides whether to exit 0/1
 * based on `ok`.
 */
export function repairWindowsBudget(): FixBudgetResult {
  // POSIX: no registry equivalent; advisory no-op. The user must edit their
  // shell profile (.bashrc/.zshrc) — there is no cross-shell auto-fix.
  if (process.platform !== "win32") {
    const lines = Object.entries(RECOMMENDED_BUDGET).map(
      ([k, v]) => `  export ${k}=${v}`,
    );
    return {
      ok: false,
      error: `--fix-budget is Windows-only. On ${process.platform}, add to your shell profile (~/.bashrc or ~/.zshrc):\n${lines.join("\n")}`,
    };
  }

  const applied: string[] = [];
  const skipped: string[] = [];
  let writeFailed = false;

  for (const [name, target] of Object.entries(RECOMMENDED_BUDGET)) {
    // Read current User-scope value.
    const current = powershell(
      `[Environment]::GetEnvironmentVariable('${name}','User')`,
    );

    // Idempotent: skip if already set to target.
    if (current === target) {
      skipped.push(name);
      continue;
    }

    // Write the target value.
    powershell(
      `[Environment]::SetEnvironmentVariable('${name}', ${JSON.stringify(target)}, 'User')`,
    );

    // Re-read to confirm the write took effect.
    const reread = powershell(
      `[Environment]::GetEnvironmentVariable('${name}','User')`,
    );
    if (reread === target) {
      applied.push(name);
    } else {
      writeFailed = true;
    }
  }

  if (writeFailed) {
    return {
      ok: false,
      error:
        "PowerShell write did not take effect for at least one variable " +
        "(permission denied? run as the same user that owns the install)",
    };
  }

  return {
    ok: true,
    alreadyOk: applied.length === 0,
    applied,
    skipped,
  };
}
