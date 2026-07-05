/**
 * workspace/postCouncilHook.ts — Run the AGENTS.MD auto-maintenance
 * after every council run completes, then run the deterministic
 * complete-design post-processor for design-phase workspaces.
 *
 * Used by `councilDispatcher` (Phase 4 wiring) to keep AGENTS.MD in
 * sync with the latest `.zelari/` artifacts and to guarantee that
 * tasks/milestones are present even when the council model (e.g.
 * composer-2.5) refuses to emit createTask/createMilestone as real
 * tool calls.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyDeterministicAutofix,
  buildCouncilCompletion,
  captureFailure,
  extractTaskScope,
  loadNfrSpec,
  runImplementationVerification,
  writeCouncilCompletion,
  writeVerificationReport,
} from "@zelari/core/council";
import type {
  CouncilCompletion,
  VerificationReport,
} from "@zelari/core/council";
import { updateAgentsMd } from "./agentsMd.js";
import { runBuiltinCompleteDesign } from "./completeDesign.js";
import { runProjectSmoke, type ProjectSmokeResult } from "./projectSmoke.js";
import type { WorkspaceContext } from "./types.js";

/** Result of the AGENTS.MD maintenance step. */
export interface HookResult {
  ran: boolean;
  changed: boolean;
  sections: string[];
  reason?: string;
}

/** Result of the complete-design post-processor step. */
export interface CompleteDesignResult {
  ran: boolean;
  exitCode?: number;
  output?: string;
  reason?: string;
}

/** Result of implementation-mode deterministic verification (Step 3). */
export interface VerificationHookResult {
  ran: boolean;
  ok?: boolean;
  reportPath?: string;
  report?: VerificationReport;
  reason?: string;
}

/** Result of the combined post-council hook (AGENTS.MD + complete-design). */
export interface PostCouncilHookResult {
  ran: boolean;
  changed: boolean;
  sections: string[];
  reason?: string;
  /** v0.7.7 Opzione B — secondary result for the complete-design post-processor. */
  completeDesign?: CompleteDesignResult;
  /** v0.8.0 — deterministic verification (implementation mode only). */
  verification?: VerificationHookResult;
  /** v0.8.2 — optional deterministic autofix before re-verify. */
  autofix?: AutofixHookResult;
  /** v0.8.3 — lessons captured from verification FAILs. */
  lessons?: LessonsHookResult;
  /** v0.9.0 — project smoke (typecheck/test/build). */
  smoke?: ProjectSmokeResult;
  /** v0.9.0 — aggregated completion artifact. */
  completion?: CompletionHookResult;
}

/** Result of Step 6 completion.json write. */
export interface CompletionHookResult {
  ran: boolean;
  path?: string;
  completion?: CouncilCompletion;
  reason?: string;
}

/** Result of Step 5 lessons capture. */
export interface LessonsHookResult {
  ran: boolean;
  captured: number;
  rejected: number;
  reason?: string;
}

export interface PostCouncilHookOptions {
  runMode?: "implementation" | "design-phase";
  /** Original user request — used for completion.json scope (v0.9.1). */
  userMessage?: string;
  /** Chairman synthesis text for honesty lint. */
  synthesisText?: string;
  /** Council run was degraded — gates PASS messaging and synthesis lint. */
  degradedRun?: boolean;
  degradedReasons?: string[];
}

/** Result of optional deterministic autofix (Step 3b). */
export interface AutofixHookResult {
  ran: boolean;
  applied?: boolean;
  filesChanged?: string[];
  fixes?: string[];
  reason?: string;
}

/**
 * v0.7.7 Opzione B / v0.7.8 — Run the deterministic complete-design
 * post-processor if the workspace is in design-phase (`.zelari/plan.json`
 * exists with at least one phase).
 *
 * Resolution order:
 *   1. A workspace-local `complete-design.mjs` at the project root wins
 *      (curated, domain-specific task templates) and is spawned as a
 *      child process.
 *   2. Otherwise (v0.7.8) the built-in TypeScript fallback runs: it
 *      derives 3 tasks per phase from the REAL phases in plan.json and
 *      guarantees a milestone — versioned with the codebase, no per-
 *      workspace setup, immune to phase-ID drift.
 *
 * Errors are captured, never thrown — the post-processor is a
 * best-effort safety net.
 *
 * Disabled by setting `ZELARI_COMPLETE_DESIGN=0` in the environment.
 */
export async function runCompleteDesignPostProcessor(
  ctx: WorkspaceContext,
  options?: { runMode?: "implementation" | "design-phase" },
): Promise<CompleteDesignResult> {
  if (options?.runMode === "implementation") {
    return {
      ran: false,
      reason: "implementation mode (complete-design skipped)",
    };
  }
  if (process.env["ZELARI_COMPLETE_DESIGN"] === "0") {
    return { ran: false, reason: "ZELARI_COMPLETE_DESIGN=0 (disabled)" };
  }

  const planJsonPath = join(ctx.rootDir, "plan.json");
  const scriptPath = join(ctx.projectRoot, "complete-design.mjs");

  if (!existsSync(planJsonPath)) {
    return {
      ran: false,
      reason: ".zelari/plan.json missing (not design-phase)",
    };
  }
  let phaseCount = 0;
  try {
    const parsed = JSON.parse(readFileSync(planJsonPath, "utf8")) as {
      phases?: unknown[];
    };
    phaseCount = Array.isArray(parsed.phases) ? parsed.phases.length : 0;
  } catch {
    return { ran: false, reason: ".zelari/plan.json corrupt" };
  }
  if (phaseCount === 0) {
    return { ran: false, reason: ".zelari/plan.json has no phases" };
  }

  if (!existsSync(scriptPath)) {
    // v0.7.8: no workspace script → run the built-in deterministic
    // fallback instead of skipping. Same guarantees (≥3 tasks per phase,
    // ≥1 milestone), zero per-workspace setup.
    try {
      const builtin = await runBuiltinCompleteDesign(ctx);
      return {
        ran: builtin.ran,
        ...(builtin.ran ? { exitCode: 0 } : {}),
        output: `builtin complete-design: +${builtin.tasksAdded} tasks, +${builtin.milestonesAdded} milestones`,
        ...(builtin.reason ? { reason: builtin.reason } : {}),
      };
    } catch (err) {
      return {
        ran: true,
        exitCode: -1,
        reason: `builtin complete-design error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return await new Promise<CompleteDesignResult>((resolveRun) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: ctx.projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      resolveRun({
        ran: true,
        exitCode: -1,
        output: stderr,
        reason: `spawn error: ${err.message}`,
      });
    });
    child.on("close", (code) => {
      const exitCode = code ?? -1;
      const ok = exitCode === 0;
      resolveRun({
        ran: true,
        exitCode,
        output: stdout + stderr,
        ...(ok
          ? {}
          : { reason: `complete-design exited with code ${exitCode}` }),
      });
    });
  });
}

/**
 * v0.8.0 — Step 3: deterministic implementation verification.
 * Skipped in design-phase and when ZELARI_VERIFY=0.
 */
export async function runImplementationVerificationHook(
  ctx: WorkspaceContext,
  options?: Pick<
    PostCouncilHookOptions,
    "runMode" | "synthesisText" | "degradedRun"
  >,
): Promise<VerificationHookResult> {
  if (options?.runMode === "design-phase") {
    return { ran: false, reason: "design-phase (verification skipped)" };
  }
  if (process.env["ZELARI_VERIFY"] === "0") {
    return { ran: false, reason: "ZELARI_VERIFY=0 (disabled)" };
  }
  try {
    const report = runImplementationVerification({
      projectRoot: ctx.projectRoot,
      zelariRoot: ctx.rootDir,
      synthesisText: options?.synthesisText,
      degradedRun: options?.degradedRun,
    });
    const reportPath = writeVerificationReport(ctx.rootDir, report);
    return { ran: true, ok: report.ok, reportPath, report };
  } catch (err) {
    return {
      ran: true,
      ok: false,
      reason: `verification error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Run the post-council hook pipeline:
 *   1. AGENTS.MD auto-maintenance (can be skipped via ZELARI_AGENTS_MD=0).
 *   2. complete-design post-processor (design-phase only, can be skipped
 *      via ZELARI_COMPLETE_DESIGN=0).
 *   3. implementation verification (implementation only, ZELARI_VERIFY=0).
 *   4. project smoke — npm run typecheck|test|build (ZELARI_SMOKE=0).
 *   5. lessons capture from verification FAILs.
 *   6. completion.json aggregate.
 *
 * The `completeDesign` field carries the secondary result so the CLI can
 * surface it ("complete-design: 12 tasks + 1 milestone added"). The
 * primary `changed`/`sections` reflect the AGENTS.MD step only.
 *
 * Errors from any step are caught and reported in the result — the
 * hook never throws.
 */
export async function runPostCouncilHook(
  ctx: WorkspaceContext,
  options?: PostCouncilHookOptions,
): Promise<PostCouncilHookResult> {
  // ── Step 1: AGENTS.MD maintenance ─────────────────────────────────────
  let agentsMdResult: HookResult;
  if (process.env["ZELARI_AGENTS_MD"] === "0") {
    agentsMdResult = {
      ran: false,
      changed: false,
      sections: [],
      reason: "ZELARI_AGENTS_MD=0 (disabled)",
    };
  } else {
    try {
      const result = await updateAgentsMd(ctx, ctx.projectRoot);
      agentsMdResult = {
        ran: true,
        changed: result.changed,
        sections: result.sections,
        ...(result.reason ? { reason: result.reason } : {}),
      };
    } catch (err) {
      agentsMdResult = {
        ran: false,
        changed: false,
        sections: [],
        reason: `error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ── Step 2: complete-design post-processor ───────────────────────────
  const completeDesign = await runCompleteDesignPostProcessor(ctx, options);

  // ── Step 3: implementation verification ──────────────────────────────
  let verification = await runImplementationVerificationHook(ctx, options);

  // ── Step 3b: optional deterministic autofix (max 1 pass) ─────────────
  let autofix: AutofixHookResult = { ran: false };
  if (
    process.env["ZELARI_VERIFY_AUTOFIX"] !== "0" &&
    verification.ran &&
    verification.ok === false &&
    verification.report
  ) {
    try {
      const fix = applyDeterministicAutofix(
        ctx.projectRoot,
        verification.report,
      );
      autofix = {
        ran: true,
        applied: fix.applied,
        filesChanged: fix.filesChanged,
        fixes: fix.fixes,
        ...(fix.applied ? {} : { reason: "no applicable deterministic fixes" }),
      };
      if (fix.applied) {
        verification = await runImplementationVerificationHook(ctx, options);
      }
    } catch (err) {
      autofix = {
        ran: true,
        applied: false,
        reason: `autofix error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ── Step 4: project smoke (implementation only) ─────────────────────
  let smoke: ProjectSmokeResult = { ran: false };
  if (options?.runMode !== "design-phase") {
    try {
      smoke = await runProjectSmoke(ctx.projectRoot);
    } catch (err) {
      smoke = {
        ran: true,
        ok: false,
        reason: `smoke error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } else {
    smoke = { ran: false, reason: "design-phase (smoke skipped)" };
  }

  // ── Step 5: capture lessons from verification FAILs ───────────────────
  let lessons: LessonsHookResult = { ran: false, captured: 0, rejected: 0 };
  if (
    process.env["ZELARI_LESSONS"] !== "0" &&
    verification.ran &&
    verification.report
  ) {
    lessons = { ran: true, captured: 0, rejected: 0 };
    for (const r of verification.report.results) {
      if (r.ok) continue;
      const cap = captureFailure(ctx.rootDir, r);
      if (cap.rejected) lessons.rejected++;
      else if (cap.captured) lessons.captured++;
    }
  } else if (process.env["ZELARI_LESSONS"] === "0") {
    lessons = {
      ran: false,
      captured: 0,
      rejected: 0,
      reason: "ZELARI_LESSONS=0 (disabled)",
    };
  }

  // ── Step 6: completion.json ───────────────────────────────────────────
  let completionHook: CompletionHookResult = { ran: false };
  if (process.env["ZELARI_COMPLETION"] === "0") {
    completionHook = { ran: false, reason: "ZELARI_COMPLETION=0 (disabled)" };
  } else if (options?.runMode !== "design-phase") {
    try {
      const scopeInput = options?.userMessage?.trim();
      const scope = scopeInput
        ? extractTaskScope({
            userMessage: scopeInput,
            nfrSpec: loadNfrSpec(ctx.rootDir),
          })
        : undefined;
      const completion = buildCouncilCompletion({
        verification,
        smoke,
        degradedRun: options?.degradedRun,
        degradedReasons: options?.degradedReasons,
        synthesisText: options?.synthesisText,
        scope: scope
          ? {
              targets: scope.targets,
              keywords: scope.keywords,
              explicitOut: scope.explicitOut,
              nfrRelevant: scope.nfrRelevant,
              sources: scope.sources,
            }
          : undefined,
      });
      const path = writeCouncilCompletion(ctx.rootDir, completion);
      completionHook = { ran: true, path, completion };
    } catch (err) {
      completionHook = {
        ran: true,
        reason: `completion error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return {
    ran:
      agentsMdResult.ran ||
      completeDesign.ran ||
      verification.ran ||
      lessons.ran ||
      smoke.ran ||
      completionHook.ran,
    changed: agentsMdResult.changed,
    sections: agentsMdResult.sections,
    ...(agentsMdResult.reason ? { reason: agentsMdResult.reason } : {}),
    completeDesign,
    verification,
    autofix,
    lessons,
    smoke,
    completion: completionHook,
  };
}
