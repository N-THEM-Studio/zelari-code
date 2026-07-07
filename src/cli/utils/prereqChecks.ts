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

interface AgentShell {
  /** Absolute path to a real bash binary, or null when falling back to cmd.exe / using /bin/sh. */
  bashPath: string | null;
  /** True when commands will run under real POSIX bash semantics. */
  isBash: boolean;
  /** Human-readable label for diagnostics, e.g. "bash (C:\\...\\bash.exe)". */
  via: string;
}

/**
 * Resolve the shell the agent will use — SYNC version of `resolveShell()`.
 *
 * Replicated (not imported) so this module has no runtime dependency on
 * @zelari/core. The detection order MUST stay in lockstep with
 * `packages/core/src/core/tools/builtin/shellResolver.ts:resolveBashWindows`:
 *   1. ZELARI_SHELL env var (explicit override)
 *   2. SHELL env var (set by Git Bash / MSYS2 sessions)
 *   3. Standard Git for Windows install paths (existsSync probe)
 *   4. `where bash` (PATH lookup)
 *   5. Fallback: cmd.exe on win32, /bin/sh on POSIX
 */
function resolveAgentShellSync(): AgentShell {
  // POSIX: Node's `shell: true` already uses /bin/sh — bash-compatible enough.
  if (process.platform !== "win32") {
    return { bashPath: null, isBash: true, via: "/bin/sh" };
  }

  // 1. Explicit override.
  const envShell = process.env.ZELARI_SHELL;
  if (envShell && envShell.trim().length > 0 && existsSyncSafe(envShell)) {
    return { bashPath: envShell, isBash: true, via: `bash (${envShell})` };
  }

  // 2. SHELL env var (Git Bash / MSYS2 sessions).
  const sessionShell = process.env.SHELL;
  if (
    sessionShell &&
    sessionShell.trim().length > 0 &&
    existsSyncSafe(sessionShell)
  ) {
    return {
      bashPath: sessionShell,
      isBash: true,
      via: `bash (${sessionShell})`,
    };
  }

  // 3. Standard install paths.
  for (const p of STANDARD_BASH_PATHS) {
    if (existsSyncSafe(p)) {
      return { bashPath: p, isBash: true, via: `bash (${p})` };
    }
  }

  // 4. `where bash` — PATH lookup. `where` ships with Windows as a real .exe.
  try {
    const result = spawnSync("where", ["bash"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status === 0 && result.stdout) {
      const first = result.stdout
        .split(/\r?\n/)
        .find((l) => l.trim().length > 0);
      if (first && existsSyncSafe(first)) {
        const trimmed = first.trim();
        return { bashPath: trimmed, isBash: true, via: `bash (${trimmed})` };
      }
    }
  } catch {
    // `where` unavailable or failed — fall through to cmd.exe.
  }

  // 5. Fallback: cmd.exe. POSIX commands (ls, which, $VAR) may fail here.
  return { bashPath: null, isBash: false, via: "cmd.exe" };
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

  if (shell.bashPath) {
    // Real bash (win32 Git Bash or explicit ZELARI_SHELL): spawn directly
    // with `-c` so we get the EXACT environment the agent's `bash` tool
    // gets — this is what catches the "node visible to main, invisible to
    // bash" mismatch.
    try {
      const r = spawnSync(shell.bashPath, ["-c", `${tool} --version`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      if (r.status === 0) stdout = (r.stdout || "").trim();
      // status !== 0 means the tool isn't on bash's PATH (or errored) — leave stdout empty.
    } catch {
      // spawn failure (e.g. bashPath stale) — fall through to empty.
    }
  } else if (process.platform === "win32") {
    // cmd.exe fallback (no Git Bash found). execSync with shell:true → cmd.exe.
    try {
      stdout = execSync(`${tool} --version`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
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
    return (
      `node is not reachable from the agent's shell (${shell.via}).\n` +
      `         This usually means Node was installed for "current user" only,\n` +
      `         while Git Bash inherits the SYSTEM Path. Fix (pick one):\n` +
      `           - Reinstall Node (https://nodejs.org) and choose\n` +
      `             "Add to PATH for all users", OR\n` +
      `           - Add C:\\Program Files\\nodejs\\ to the SYSTEM Path\n` +
      `             (System Properties → Environment Variables → Path), OR\n` +
      `           - Set ZELARI_SHELL to a bash that already sees node.`
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
 * Check that a real bash is available on Windows. When the resolver falls
 * back to cmd.exe, POSIX commands (`ls`, `which`, `$VAR`, `&&`) will fail
 * inside the agent's `bash` tool — confusing and hard to debug. Warn only.
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
  return {
    ok: false,
    severity: "warn",
    tool: "bash",
    message:
      `no Git Bash found — the agent's \`bash\` tool falls back to cmd.exe,\n` +
      `         where POSIX commands (ls, which, $VAR, &&) may fail. Install Git\n` +
      `         for Windows (https://git-scm.com/download/win) or set ZELARI_SHELL\n` +
      `         to your bash binary.`,
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
