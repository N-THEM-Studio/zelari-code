import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCmdLine } from "../utils/cmdline.js";

export const SMOKE_SCRIPT_PRIORITY = ["typecheck", "test", "build"] as const;

export type SmokeScriptName = (typeof SMOKE_SCRIPT_PRIORITY)[number];

export interface ProjectSmokeResult {
  ran: boolean;
  ok?: boolean;
  script?: SmokeScriptName;
  exitCode?: number;
  output?: string;
  reason?: string;
}

export function pickSmokeScript(
  scripts: Record<string, string> | undefined,
): SmokeScriptName | null {
  if (!scripts) return null;
  for (const name of SMOKE_SCRIPT_PRIORITY) {
    if (scripts[name]) return name;
  }
  return null;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * v0.9.0 Step 4 — run first available npm script among typecheck/test/build.
 * Skipped when no script exists (not a FAIL). FAIL when script exits non-zero.
 */
export async function runProjectSmoke(
  projectRoot: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ProjectSmokeResult> {
  if (process.env["ZELARI_SMOKE"] === "0") {
    return { ran: false, reason: "ZELARI_SMOKE=0 (disabled)" };
  }

  const pkgPath = join(projectRoot, "package.json");
  if (!existsSync(pkgPath)) {
    return { ran: false, reason: "no package.json (skipped)" };
  }

  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    scripts = pkg.scripts ?? {};
  } catch {
    return { ran: false, reason: "package.json unreadable (skipped)" };
  }

  const script = pickSmokeScript(scripts);
  if (!script) {
    return { ran: false, reason: "no typecheck/test/build script (skipped)" };
  }

  return await new Promise<ProjectSmokeResult>((resolveRun) => {
    // On win32 shell:true is needed so .cmd shims resolve, but passing args
    // array with shell:true is deprecated (DEP0190). Use buildCmdLine to
    // pre-quote args into a single string; shell:true can then resolve npm.
    // NOTE: must use npm.cmd (not npm) on Windows — fnm/nvm-windows shims
    // can fail to resolve the bare name through cmd.exe PATHEXT.
    const child =
      process.platform === "win32"
        ? spawn(buildCmdLine("npm.cmd", ["run", script]), {
            cwd: projectRoot,
            stdio: ["ignore", "pipe", "pipe"],
            env: process.env,
            shell: true,
          })
        : spawn("npm", ["run", script], {
            cwd: projectRoot,
            stdio: ["ignore", "pipe", "pipe"],
            env: process.env,
          });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: ProjectSmokeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        ran: true,
        ok: false,
        script,
        exitCode: -1,
        output: stdout + stderr,
        reason: `smoke timeout after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      finish({
        ran: true,
        ok: false,
        script,
        exitCode: -1,
        output: stderr,
        reason: `spawn error: ${err.message}`,
      });
    });
    child.on("close", (code) => {
      const exitCode = code ?? -1;
      const ok = exitCode === 0;
      finish({
        ran: true,
        ok,
        script,
        exitCode,
        output: (stdout + stderr).slice(-8000),
        ...(ok ? {} : { reason: `npm run ${script} exited with code ${exitCode}` }),
      });
    });
  });
}
