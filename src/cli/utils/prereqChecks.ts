/**
 * prereqChecks.ts — prerequisite detection that mirrors the agent's shell.
 *
 * Why this exists separately from `doctor.ts`:
 *   The legacy `checkNode()` in doctor.ts probes `node --version` from the
 *   zelari-code main process. On Windows that main process is a native Node
 *   binary whose PATH always contains node (otherwise zelari-code wouldn't
 *   be running). But the AGENT — the thing that actually runs `npm`,
 *   `tsc`, build scripts — launches commands through the resolved shell
 *   (Git Bash on Windows, see `resolveShell()` in shellResolver.ts), which
 *   inherits a DIFFERENT PATH. A user can have node visible to the main
 *   process yet invisible to the agent's bash (e.g. Node installed for
 *   "current user" only, while Git Bash inherits the system PATH). The
 *   legacy doctor check passes in that case and never warns — until the
 *   agent tries `npm run build` and gets `node: not found`, mid-task.
 *
 *   These checks probe THROUGH the same shell the agent will use, so they
 *   detect the real mismatch before it bites. They power:
 *     - the boot-time preflight (src/cli/main.ts `runPreflight`),
 *     - the `--doctor` "agent shell" rows (src/cli/utils/doctor.ts),
 *     - the post-update prerequisite warnings (slashHandlers/updater.ts).
 *
 * Design contract (inherited from doctor.ts):
 *   - NEVER throws. Every check catches its own errors and returns a
 *     FAIL/WARN result. A broken prereq check must never crash the CLI.
 *   - Sync API: doctor's `run()` loop is sync and we keep that shape.
 *   - No dependency on @zelari/core: the bash-resolution chain is
 *     replicated here (see `resolveAgentShellSync` below) so this module
 *     works even when the core bundle is broken — which is exactly when a
 *     user needs `--doctor` to diagnose the breakage.
 *
 * @see packages/core/src/core/tools/builtin/shellResolver.ts — the canonical
 *      resolver; keep `resolveAgentShellSync` in sync with its detection chain.
 * @see src/cli/utils/doctor.ts — the opt-in `zelari-code doctor` command.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

/** Minimum Node major version (mirrors `engines.node` ">=20.0.0" in package.json). */
const MIN_NODE_MAJOR = 20;

export interface PrereqResult {
  ok: boolean;
  /** 'critical' = blocks boot/update; 'warn' = non-blocking. */
  severity: "critical" | "warn";
  /** Human-readable status, including actionable fix hints when failing. */
  message: string;
  /** Which tool this result is about: 'node' | 'git' | 'bash'. */
  tool: "node" | "git" | "bash";
}

/** Standard Git for Windows bash locations (mirrors shellResolver.STANDARD_BASH_PATHS). */
const STANDARD_BASH_PATHS = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
];

/** PowerShell binary names (mirrors shellResolver.POWERSHELL_EXES). */
const POWERSHELL_EXES = ["pwsh.exe", "powershell.exe"];

/** Standard PowerShell install paths (mirrors shellResolver.STANDARD_POWERSHELL_PATHS). */
const STANDARD_POWERSHELL_PATHS = [
  "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  "C:\\Program Files\\PowerShell\\7\\powershell.exe",
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  "C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe",
];

export interface AgentShell {
  /** Absolute path to a real bash or PowerShell binary, or null when falling back to cmd.exe / using /bin/sh. */
  bashPath: string | null;
  /** True when commands will run under real POSIX bash semantics. */
  isBash: boolean;
  /** True when commands will run under PowerShell (spawn via -Command). */
  isPowerShell: boolean;
  /** Human-readable label for diagnostics, e.g. "bash (C:\\...\\bash.exe)". */
  via: string;
}

/**
 * True when `p` is the WSL bash launcher, not Git Bash.
 * Must stay in lockstep with `shellResolver.isWslBashPath`.
 *
 * @see packages/core/src/core/tools/builtin/shellResolver.ts
 */
export function isWslBashPath(p: string): boolean {
  if (!p || typeof p !== "string") return false;
  const n = p.replace(/\//g, "\\").toLowerCase();
  if (n.includes("\\windows\\system32\\bash.exe")) return true;
  if (n.includes("\\windows\\syswow64\\bash.exe")) return true;
  if (n.includes("\\windowsapps\\bash.exe")) return true;
  return false;
}

/**
 * True when `p` is a PowerShell binary (pwsh.exe or powershell.exe).
 * Mirrors `shellResolver.isPowerShellPath`.
 */
export function isPowerShellPath(p: string): boolean {
  if (!p || typeof p !== "string") return false;
  const lower = p.toLowerCase().trim();
  return POWERSHELL_EXES.some((exe) => lower.endsWith(exe));
}

/** Accept only a real (non-WSL, non-PowerShell) bash path that exists on disk. */
function acceptBashPath(p: string | undefined | null): string | null {
  if (!p || p.trim().length === 0) return null;
  const trimmed = p.trim();
  if (isWslBashPath(trimmed)) return null;
  if (isPowerShellPath(trimmed)) return null; // PowerShell → resolvePowerShellWindowsSync
  if (!existsSyncSafe(trimmed)) return null;
  return trimmed;
}

/** Accept a PowerShell path that exists on disk. Rejects WSL bash and non-PowerShell paths. */
function acceptPowerShellPath(p: string | undefined | null): string | null {
  if (!p || p.trim().length === 0) return null;
  const trimmed = p.trim();
  if (isWslBashPath(trimmed)) return null;
  if (!isPowerShellPath(trimmed)) return null;
  if (!existsSyncSafe(trimmed)) return null;
  return trimmed;
}

/**
 * SYNC PowerShell detection chain. Mirrors `shellResolver.resolvePowerShellWindows`.
 * Returns the path or null.
 */
function resolvePowerShellWindowsSync(): string | null {
  // 1. ZELARI_SHELL env var — if it points to a PowerShell, use it.
  const fromEnv = acceptPowerShellPath(process.env.ZELARI_SHELL);
  if (fromEnv) return fromEnv;

  // 2. Standard install paths.
  for (const p of STANDARD_POWERSHELL_PATHS) {
    const accepted = acceptPowerShellPath(p);
    if (accepted) return accepted;
  }

  // 3. `where pwsh` / `where powershell` — PATH lookup.
  try {
    for (const name of POWERSHELL_EXES) {
      const result = spawnSync("where", [name], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (result.status === 0 && result.stdout) {
        for (const line of result.stdout.split(/\r?\n/)) {
          const accepted = acceptPowerShellPath(line);
          if (accepted) return accepted;
        }
      }
    }
  } catch {
    // `where` unavailable or failed — fall through.
  }

  return null;
}

/**
 * Resolve the shell the agent will use — SYNC version of `resolveShell()`.
 *
 * Replicated (not imported) so this module has no runtime dependency on
 * @zelari/core. The detection order MUST stay in lockstep with
 * `packages/core/src/core/tools/builtin/shellResolver.ts:resolveShell`:
 *   1. ZELARI_SHELL env var (explicit override; WSL rejected)
 *   2. SHELL env var (set by Git Bash / MSYS2 sessions; WSL rejected)
 *   3. Standard Git for Windows install paths (existsSync probe)
 *   4. `where bash` (PATH lookup; skip WSL launchers)
 *   5. Standard PowerShell install paths + `where pwsh`/`where powershell`
 *   6. Fallback: cmd.exe on win32, /bin/sh on POSIX
 */
function resolveAgentShellSync(): AgentShell {
  // POSIX: Node's `shell: true` already uses /bin/sh — bash-compatible enough.
  if (process.platform !== "win32") {
    return { bashPath: null, isBash: true, isPowerShell: false, via: "/bin/sh" };
  }

  // 1. Explicit override.
  const fromEnv = acceptBashPath(process.env.ZELARI_SHELL);
  if (fromEnv) {
    return { bashPath: fromEnv, isBash: true, isPowerShell: false, via: `bash (${fromEnv})` };
  }

  // 2. SHELL env var (Git Bash / MSYS2 sessions).
  const fromSession = acceptBashPath(process.env.SHELL);
  if (fromSession) {
    return {
      bashPath: fromSession,
      isBash: true,
      isPowerShell: false,
      via: `bash (${fromSession})`,
    };
  }

  // 3. Standard install paths.
  for (const p of STANDARD_BASH_PATHS) {
    const accepted = acceptBashPath(p);
    if (accepted) {
      return { bashPath: accepted, isBash: true, isPowerShell: false, via: `bash (${accepted})` };
    }
  }

  // 4. `where bash` — PATH lookup. `where` ships with Windows as a real .exe.
  // Skip WSL launchers (System32/WindowsApps); prefer a later non-WSL hit.
  try {
    const result = spawnSync("where", ["bash"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status === 0 && result.stdout) {
      for (const line of result.stdout.split(/\r?\n/)) {
        const accepted = acceptBashPath(line);
        if (accepted) {
          return {
            bashPath: accepted,
            isBash: true,
            isPowerShell: false,
            via: `bash (${accepted})`,
          };
        }
      }
    }
  } catch {
    // `where` unavailable or failed — fall through.
  }

  // 5. No bash found — try PowerShell (available on every modern Windows).
  const psFound = resolvePowerShellWindowsSync();
  if (psFound) {
    return { bashPath: psFound, isBash: false, isPowerShell: true, via: `powershell (${psFound})` };
  }

  // 6. Fallback: cmd.exe. POSIX commands (ls, which, $VAR) may fail here.
  return { bashPath: null, isBash: false, isPowerShell: false, via: "cmd.exe" };
}

/**
 * Env for agent-shell probes/spawns: ensure the directory that hosts the
 * running node binary is on PATH (covers "user-only Node install" when the
 * main process already found node via a richer PATH than Git Bash inherits).
 */
function agentProbeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  try {
    const nodeDir = dirname(process.execPath);
    if (!nodeDir) return env;
    const sep = process.platform === "win32" ? ";" : ":";
    const current = env.PATH ?? env.Path ?? "";
    const parts = current.split(sep).filter((p) => p.length > 0);
    const has = parts.some(
      (p) => p.toLowerCase() === nodeDir.toLowerCase(),
    );
    if (!has) {
      env.PATH = `${nodeDir}${sep}${current}`;
    }
  } catch {
    // ignore — best-effort
  }
  return env;
}

/** existsSync that swallows edge-case errors (invalid chars on win32, etc.). */
function existsSyncSafe(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Probe `<tool> --version` through the agent's resolved shell.
 *
 * Returns the raw stdout (trimmed) and parsed semver, or empty strings when
 * the tool isn't reachable. Never throws.
 */
function probeTool(
  tool: "node" | "git",
): { found: boolean; version: string; raw: string } {
  const shell = resolveAgentShellSync();
  let stdout = "";

  const env = agentProbeEnv();

  if (shell.bashPath) {
    if (shell.isPowerShell) {
      // PowerShell: spawn with -Command (works on PS5.1 and PS7+).
      try {
        const r = spawnSync(shell.bashPath, ["-Command", `${tool} --version`], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
          env,
        });
        if (r.status === 0) stdout = (r.stdout || "").trim();
      } catch {
        // spawn failure — fall through to empty.
      }
    } else {
      // Real bash (win32 Git Bash or explicit ZELARI_SHELL): spawn directly
      // with `-c` so we get the EXACT environment the agent's `bash` tool
      // gets — this is what catches the "node visible to main, invisible to
      // bash" mismatch. PATH is enriched with dirname(process.execPath).
      try {
        const r = spawnSync(shell.bashPath, ["-c", `${tool} --version`], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
          env,
        });
        if (r.status === 0) stdout = (r.stdout || "").trim();
        // status !== 0 means the tool isn't on bash's PATH (or errored) — leave stdout empty.
      } catch {
        // spawn failure (e.g. bashPath stale) — fall through to empty.
      }
    }
  } else if (process.platform === "win32") {
    // cmd.exe fallback (no Git Bash found / WSL-only). shell:true → cmd.exe.
    try {
      stdout = execSync(`${tool} --version`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env,
      }).trim();
    } catch {
      // not on cmd's PATH either
    }
  } else {
    // POSIX non-bash (shouldn't happen — resolveAgentShellSync returns isBash:true on POSIX).
    try {
      stdout = execSync(`${tool} --version`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env,
      }).trim();
    } catch {
      // ignore
    }
  }

  const m = stdout.match(/(\d+)\.(\d+)\.(\d+)/);
  return {
    found: stdout.length > 0,
    version: m ? `${m[1]}.${m[2]}.${m[3]}` : "",
    raw: stdout,
  };
}

/**
 * Actionable fix hint when node isn't visible to the agent shell.
 * OS-specific because the root cause differs (system vs user PATH on Windows;
 * nvm symlink on macOS/Linux; missing install entirely).
 */
function nodeMissingHint(): string {
  const shell = resolveAgentShellSync();
  if (process.platform === "win32") {
    if (!shell.isBash) {
      // cmd.exe fallback still can't see node → genuine missing/broken PATH.
      return (
        `node is not reachable from the agent's shell (${shell.via}).\n` +
        `         Install Node >= ${MIN_NODE_MAJOR} (https://nodejs.org) and ensure it is\n` +
        `         on PATH, then open a NEW terminal. Optional: install Git for\n` +
        `         Windows so the agent can use real bash (https://git-scm.com/download/win).`
      );
    }
    // Real Git Bash (or ZELARI_SHELL) selected but node missing inside it.
    return (
      `node is not reachable from the agent's shell (${shell.via}).\n` +
      `         This usually means Node was installed for "current user" only,\n` +
      `         while Git Bash sees a different Path. Fix (pick one):\n` +
      `           - Reinstall Node (https://nodejs.org) and choose\n` +
      `             "Add to PATH for all users", OR\n` +
      `           - Add your nodejs folder to the User or System Path, OR\n` +
      `           - Set ZELARI_SHELL to a bash that already sees node.\n` +
      `         Note: WSL's C:\\Windows\\System32\\bash.exe is NOT a valid agent\n` +
      `         shell — install Git for Windows instead.`
    );
  }
  return (
    `node is not on the agent's shell PATH.\n` +
    `         Install Node >= ${MIN_NODE_MAJOR} (https://nodejs.org) or, if you use\n` +
    `         nvm, run \`nvm use <version>\` and reopen this terminal.`
  );
}

/** Check `node` is reachable from the agent shell and meets the minimum version. */
export function checkAgentNode(): PrereqResult {
  const probe = probeTool("node");
  if (!probe.found) {
    return {
      ok: false,
      severity: "critical",
      tool: "node",
      message: nodeMissingHint(),
    };
  }
  const major = Number(probe.version.split(".")[0]);
  if (!probe.version || Number.isNaN(major)) {
    // node IS on PATH but version string looks weird — degrade to warn, don't hard-fail.
    return {
      ok: false,
      severity: "warn",
      tool: "node",
      message: `could not parse node version from "${probe.raw}" (node is reachable, but version check skipped)`,
    };
  }
  if (major < MIN_NODE_MAJOR) {
    return {
      ok: false,
      severity: "critical",
      tool: "node",
      message: `node ${probe.version} is older than the required >= ${MIN_NODE_MAJOR}.0.0 (from engines.node). Upgrade: https://nodejs.org`,
    };
  }
  return {
    ok: true,
    severity: "critical",
    tool: "node",
    message: `node ${probe.version} (agent shell)`,
  };
}

/** Check `git` is reachable from the agent shell. Soft prereq (warn, not block). */
export function checkAgentGit(): PrereqResult {
  const probe = probeTool("git");
  if (!probe.found) {
    const hint =
      process.platform === "win32"
        ? `Install Git for Windows: https://git-scm.com/download/win`
        : `Install git (e.g. \`brew install git\` on macOS, \`apt install git\` on Debian)`;
    return {
      ok: false,
      severity: "warn",
      tool: "git",
      message: `git not found on the agent's shell PATH — /diff, /undo and the git sidebar will be disabled. ${hint}`,
    };
  }
  return {
    ok: true,
    severity: "warn",
    tool: "git",
    message: `git ${probe.version} (agent shell)`,
  };
}

/**
 * Check that a real bash (or PowerShell) is available on Windows. When the
 * resolver falls back to cmd.exe, POSIX commands (`ls`, `which`, `$VAR`,
 * `&&`) will fail inside the agent's `bash` tool — confusing and hard to
 * debug. PowerShell is a workable fallback (better than cmd.exe). Warn only.
 */
export function checkAgentBash(): PrereqResult {
  if (process.platform !== "win32") {
    return {
      ok: true,
      severity: "warn",
      tool: "bash",
      message: "POSIX shell always available on this platform",
    };
  }
  const shell = resolveAgentShellSync();
  if (shell.isBash) {
    return {
      ok: true,
      severity: "warn",
      tool: "bash",
      message: `real bash available (${shell.via})`,
    };
  }
  if (shell.isPowerShell) {
    return {
      ok: true,
      severity: "warn",
      tool: "bash",
      message: `PowerShell available (${shell.via}) — works as bash replacement`,
    };
  }
  return {
    ok: false,
    severity: "warn",
    tool: "bash",
    message:
      "no Git Bash or PowerShell — bash tool uses cmd.exe (install Git for Windows, or set ZELARI_SHELL). Details: zelari-code --doctor",
  };
}

/**
 * Probe `node --version` from the zelari-code main process (NOT the agent
 * shell). Kept for differential diagnostics: if this passes but
 * `checkAgentNode` fails, the problem is a PATH mismatch between the main
 * process and the agent's bash — not a missing Node install.
 */
export function checkMainNode(): PrereqResult {
  try {
    const raw = execSync("node --version", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = raw.match(/(\d+)\.(\d+)\.(\d+)/);
    const version = m ? `${m[1]}.${m[2]}.${m[3]}` : "";
    const major = Number(version.split(".")[0]);
    if (version && !Number.isNaN(major) && major >= MIN_NODE_MAJOR) {
      return {
        ok: true,
        severity: "critical",
        tool: "node",
        message: `node ${version} (main process)`,
      };
    }
    return {
      ok: false,
      severity: "warn",
      tool: "node",
      message: `node present in main process but version unparseable or < ${MIN_NODE_MAJOR}: "${raw}"`,
    };
  } catch {
    return {
      ok: false,
      severity: "critical",
      tool: "node",
      message:
        "node not found on the main process PATH (zelari-code itself runs on node — this is unexpected)",
    };
  }
}

export interface PrereqRunResult {
  results: PrereqResult[];
  hasCriticalFail: boolean;
  warnings: PrereqResult[];
}

/**
 * Run all prerequisite checks and aggregate. Never throws.
 *
 * @param opts.mode 'preflight' = boot-time gate (node critical, git/bash warn);
 *                  'full' = same checks, used by `--doctor` for the full report.
 *                  Currently identical; the flag is reserved for future
 *                  heavier checks that shouldn't run on every boot.
 */
export function runPrereqChecks(
  opts: { mode: "preflight" | "full" } = { mode: "preflight" },
): PrereqRunResult {
  const checks: Array<() => PrereqResult> = [
    () => checkAgentNode(),
    () => checkAgentGit(),
    () => checkAgentBash(),
  ];

  const results: PrereqResult[] = [];
  for (const run of checks) {
    try {
      results.push(run());
    } catch (err) {
      // Defensive: a check throwing is itself a failure, never a crash.
      results.push({
        ok: false,
        severity: "warn",
        tool: "node",
        message: `prereq check crashed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const hasCriticalFail = results.some(
    (r) => !r.ok && r.severity === "critical",
  );
  const warnings = results.filter((r) => !r.ok && r.severity === "warn");

  // Reference opts.mode so it stays meaningful even while behaviour is identical
  // across modes today (reserved for future full-only checks).
  void opts.mode;

  return { results, hasCriticalFail, warnings };
}
