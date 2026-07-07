/**
 * doctor.ts — `zelari-code doctor` diagnostic.
 *
 * Run after a fresh install (or when something looks wrong) to check:
 *   1. Bin shim health (does `zelari-code.cmd` / `zelari-code` exist
 *      in the npm global prefix, and does it reference the right
 *      package install?).
 *   2. Node availability (`node` on PATH, version >= engines.node).
 *   3. CLI bundle presence (did `npm run build:cli` produce
 *      `dist/cli/main.bundled.js`?).
 *   4. Runtime deps (ink / react / zod / ink-text-input resolvable
 *      from the package root).
 *   5. @zelari/core dependency (only checked if it appears in the
 *      package's deps or devDeps — it's a build-time dep for the
 *      workspace, and a runtime dep only for the source/tsx fallback
 *      path in bin/zelari-code.js).
 *   6. PATH includes the npm global prefix.
 *
 * Output is human-readable, with one line per check + a trailing
 * summary. Non-zero exit code if any critical check fails so this
 * can be used in CI / install scripts.
 *
 * The function never throws: it catches all per-check errors and
 * reports them as "FAIL" with the error message. The final return
 * value tells the caller whether the install is healthy.
 *
 * @see scripts/postinstall.mjs — the install-time shim check
 * @see src/cli/updater.ts — the self-update mechanism
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  checkAgentNode,
  checkAgentGit,
  checkAgentBash,
  type PrereqResult,
} from "./prereqChecks.js";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/cli/utils/doctor.ts → <pkg>/src/cli/utils/doctor.ts
// We need <pkg> root. In dev (tsx) this is src/cli/utils/, in prod (bundled) it's dist/cli/utils/.
// In both cases we want the package root: that's `../../` from src/cli/utils, and `../../../` from dist/cli/utils/...
// Simplest: walk up until we find package.json with our name.
const packageRoot = findPackageRoot(__dirname);

function findPackageRoot(start: string): string {
  let dir = start;
  // Walk at most 6 levels up (src/cli/utils -> src/cli -> src -> root, dist/cli/utils -> dist/cli -> dist -> root).
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as {
          name?: string;
        };
        if (pkg.name === "zelari-code") return dir;
      } catch {
        // ignore
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume standard layout.
  return path.resolve(__dirname, "..", "..", "..");
}

type CheckResult = {
  ok: boolean;
  message: string;
  /** 'critical' = blocks the install; 'warn' = non-blocking issue. */
  severity: "critical" | "warn";
};

const OK = (message: string): CheckResult => ({
  ok: true,
  message,
  severity: "critical",
});
const FAIL = (
  message: string,
  severity: "critical" | "warn" = "critical",
): CheckResult => ({
  ok: false,
  message,
  severity,
});
const WARN = (message: string): CheckResult => ({
  ok: false,
  message,
  severity: "warn",
});

/** Run a shell command and return trimmed stdout. Empty string on failure. */
function tryExec(cmd: string): string {
  try {
    return execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** Read the installed package.json (for name + version + bin path). */
function readPackageJson(): {
  name: string;
  version: string;
  bin?: string | Record<string, string>;
} | null {
  try {
    const pkgPath = path.join(packageRoot, "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf8")) as {
      name: string;
      version: string;
      bin?: string | Record<string, string>;
    };
  } catch {
    return null;
  }
}

/** Resolve the npm global prefix. Empty string on failure. */
function getGlobalPrefix(): string {
  return (
    (
      process.env.npm_config_prefix ||
      process.env.NPM_CONFIG_PREFIX ||
      ""
    ).trim() || tryExec("npm prefix -g")
  );
}

/** Check the bin shim in the global prefix. */
function checkShim(pkgName: string): CheckResult {
  const prefix = getGlobalPrefix();
  if (!prefix) {
    return WARN("npm global prefix not detectable (run inside an npm context)");
  }
  const isWin = process.platform === "win32";
  const shimName = isWin ? "zelari-code.cmd" : "zelari-code";
  const shimPath = path.join(prefix, shimName);
  if (!existsSync(shimPath)) {
    return FAIL(
      `shim not found at ${shimPath}\n` +
        `         fix:  npm install -g ${pkgName}@latest --force`,
    );
  }
  try {
    const st = statSync(shimPath);
    if (isWin) {
      const content = readFileSync(shimPath, "utf8");
      if (
        content.includes(`${pkgName}\\bin\\`) ||
        content.includes(`${pkgName}/bin/`)
      ) {
        return OK(`shim OK at ${shimPath} (${st.size} bytes)`);
      }
      return FAIL(
        `shim at ${shimPath} does not reference ${pkgName}/bin/\n` +
          `         fix:  npm install -g ${pkgName}@latest --force`,
      );
    }
    let target: string;
    try {
      target = readlinkSync(shimPath);
    } catch {
      return FAIL(
        `shim at ${shimPath} is not a symlink (POSIX global installs should be symlinks)\n` +
          `         fix:  npm install -g ${pkgName}@latest --force`,
      );
    }
    const resolved = path.resolve(path.dirname(shimPath), target);
    const expected = path.join(
      prefix,
      "node_modules",
      pkgName,
      "bin",
      "zelari-code.js",
    );
    if (resolved === expected) {
      return OK(`shim OK at ${shimPath} → ${resolved}`);
    }
    return FAIL(
      `shim at ${shimPath} points to ${resolved}\n` +
        `         expected ${expected}\n` +
        `         fix:  npm install -g ${pkgName}@latest --force`,
    );
  } catch (err) {
    return FAIL(
      `could not inspect shim: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Check that node is on PATH and meets the engines requirement. */
function checkNode(
  pkg: {
    name?: string;
    version?: string;
    engines?: { node?: string };
    bin?: string | Record<string, string>;
  } | null,
): CheckResult {
  const raw = tryExec("node --version");
  if (!raw) {
    return FAIL("`node` not found on PATH");
  }
  // raw is like "v20.11.1"
  const m = raw.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) {
    return WARN(`could not parse node version: ${raw}`);
  }
  const major = Number(m[1]);
  if (major < 20) {
    return FAIL(
      `node ${raw} is older than the required engines.node (>= 20.0.0)`,
    );
  }
  return OK(`node ${raw}`);
}

/** Check the CLI bundle exists. */
function checkBundle(): CheckResult {
  const bundle = path.join(packageRoot, "dist", "cli", "main.bundled.js");
  if (!existsSync(bundle)) {
    return FAIL(
      `dist/cli/main.bundled.js missing at ${bundle}\n` +
        `         fix:  npm run build:cli   (then reinstall or run via tsx)`,
    );
  }
  try {
    const st = statSync(bundle);
    return OK(`bundle OK (${(st.size / 1024 / 1024).toFixed(2)} MB)`);
  } catch (err) {
    return FAIL(
      `could not stat bundle: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Check each runtime dep is resolvable. */
function checkRuntimeDeps(): CheckResult {
  const required = ["react", "react-dom", "ink", "ink-text-input", "zod"];
  const missing: string[] = [];
  for (const dep of required) {
    try {
      // createRequire from the package root — this is what `node bin/zelari-code.js` uses.
      const localReq = createRequire(path.join(packageRoot, "package.json"));
      localReq.resolve(dep);
    } catch {
      missing.push(dep);
    }
  }
  if (missing.length === 0) {
    return OK(
      "runtime deps resolvable (react, react-dom, ink, ink-text-input, zod)",
    );
  }
  return FAIL(
    `missing runtime deps: ${missing.join(", ")}\n` +
      `         fix:  npm install -g ${"<pkg>"} --force    (then reopen the terminal)`,
  );
}

/** Check PATH includes the npm global prefix. */
function checkPath(): CheckResult {
  const prefix = getGlobalPrefix();
  if (!prefix) return WARN("npm global prefix not detectable");
  const pathSep = process.platform === "win32" ? ";" : ":";
  const pathDirs = (process.env.PATH || "").split(pathSep);
  if (pathDirs.includes(prefix)) {
    return OK(`PATH includes npm prefix (${prefix})`);
  }
  return WARN(
    `PATH does not include npm prefix (${prefix})\n` +
      `         symptom: "zelari-code: command not found" after install\n` +
      `         fix (POSIX):   export PATH="$(npm prefix -g)/bin:$PATH"\n` +
      `         fix (Windows): $env:Path = "$(npm prefix -g);$env:Path"`,
  );
}

/**
 * Adapt a `PrereqResult` (from prereqChecks.ts) into doctor's `CheckResult`.
 * The shapes are isomorphic — this is a pure pass-through that lets the
 * agent-shell-aware checks share the doctor's report formatting + summary.
 * Keep severity semantics intact: 'critical' FAILs the report, 'warn' is advisory.
 */
function prereqToCheckResult(r: PrereqResult): CheckResult {
  if (r.ok) return OK(r.message);
  return r.severity === "critical"
    ? FAIL(r.message, "critical")
    : WARN(r.message);
}

/**
 * Run all checks and print results. Returns true if install is healthy
 * (no critical failures), false otherwise. Never throws.
 */
export function runDoctor(): boolean {
  const pkg = readPackageJson();
  const pkgName = pkg?.name ?? "zelari-code";

  const checks: Array<{ name: string; run: () => CheckResult }> = [
    // --- install-health checks (main-process probes) ---
    { name: "node", run: () => checkNode(pkg) },
    { name: "bin shim", run: () => checkShim(pkgName) },
    { name: "cli bundle", run: () => checkBundle() },
    { name: "runtime deps", run: () => checkRuntimeDeps() },
    { name: "PATH", run: () => checkPath() },
    // --- agent-shell checks (v1.4.0) ---
    // These probe node/git/bash THROUGH the resolved shell the agent uses.
    // A pass on "node" + a FAIL on "node (agent shell)" is the tell-tale
    // signature of the PATH-mismatch bug (node visible to the main process,
    // invisible to Git Bash) that silently breaks council builds.
    { name: "node (agent shell)", run: () => prereqToCheckResult(checkAgentNode()) },
    { name: "git (agent shell)", run: () => prereqToCheckResult(checkAgentGit()) },
    { name: "bash", run: () => prereqToCheckResult(checkAgentBash()) },
  ];

  // eslint-disable-next-line no-console
  console.log(`zelari-code doctor (v${pkg?.version ?? "unknown"})`);
  // eslint-disable-next-line no-console
  console.log("platform:", process.platform, process.arch);
  // eslint-disable-next-line no-console
  console.log("node:    ", process.version);
  // eslint-disable-next-line no-console
  console.log("prefix:  ", getGlobalPrefix() || "(unknown)");
  // eslint-disable-next-line no-console
  console.log("root:    ", packageRoot);
  // eslint-disable-next-line no-console
  console.log("");

  let criticalFails = 0;
  let warns = 0;

  for (const c of checks) {
    let result: CheckResult;
    try {
      result = c.run();
    } catch (err) {
      result = FAIL(
        `unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const tag = result.ok
      ? "OK  "
      : result.severity === "critical"
        ? "FAIL"
        : "WARN";
    const color = result.ok
      ? "\x1b[32m"
      : result.severity === "critical"
        ? "\x1b[31m"
        : "\x1b[33m";
    const reset = "\x1b[0m";
    // eslint-disable-next-line no-console
    console.log(
      `  ${color}${tag}${reset}  ${c.name.padEnd(14)}${result.message.replace(/\n/g, "\n              ")}`,
    );
    if (!result.ok) {
      if (result.severity === "critical") criticalFails += 1;
      else warns += 1;
    }
  }

  // eslint-disable-next-line no-console
  console.log("");
  if (criticalFails === 0 && warns === 0) {
    // eslint-disable-next-line no-console
    console.log("\x1b[32m✔ all checks passed\x1b[0m");
    return true;
  }
  // eslint-disable-next-line no-console
  console.log(`✗ ${criticalFails} critical failure(s), ${warns} warning(s)`);
  return criticalFails === 0;
}
