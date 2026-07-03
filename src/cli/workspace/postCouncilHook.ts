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

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { updateAgentsMd } from './agentsMd.js';
import type { WorkspaceContext } from './types.js';

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

/** Result of the combined post-council hook (AGENTS.MD + complete-design). */
export interface PostCouncilHookResult {
  ran: boolean;
  changed: boolean;
  sections: string[];
  reason?: string;
  /** v0.7.7 Opzione B — secondary result for the complete-design post-processor. */
  completeDesign?: CompleteDesignResult;
}

/**
 * v0.7.7 Opzione B — Run the deterministic complete-design post-processor
 * if the workspace is in design-phase (`.zelari/plan.json` exists with at
 * least one phase) and the script is present at the project root.
 *
 * The script is spawned as a child process (Node) so we don't need to
 * re-implement its logic in TypeScript. Errors are captured, never
 * thrown — the post-processor is a best-effort safety net.
 *
 * Disabled by setting `ZELARI_COMPLETE_DESIGN=0` in the environment.
 */
export async function runCompleteDesignPostProcessor(
  ctx: WorkspaceContext,
): Promise<CompleteDesignResult> {
  if (process.env['ZELARI_COMPLETE_DESIGN'] === '0') {
    return { ran: false, reason: 'ZELARI_COMPLETE_DESIGN=0 (disabled)' };
  }

  const planJsonPath = join(ctx.rootDir, 'plan.json');
  const scriptPath = join(ctx.projectRoot, 'complete-design.mjs');

  if (!existsSync(planJsonPath)) {
    return { ran: false, reason: '.zelari/plan.json missing (not design-phase)' };
  }
  let phaseCount = 0;
  try {
    const parsed = JSON.parse(readFileSync(planJsonPath, 'utf8')) as {
      phases?: unknown[];
    };
    phaseCount = Array.isArray(parsed.phases) ? parsed.phases.length : 0;
  } catch {
    return { ran: false, reason: '.zelari/plan.json corrupt' };
  }
  if (phaseCount === 0) {
    return { ran: false, reason: '.zelari/plan.json has no phases' };
  }

  if (!existsSync(scriptPath)) {
    return { ran: false, reason: `complete-design.mjs not found at ${scriptPath}` };
  }

  return await new Promise<CompleteDesignResult>((resolveRun) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: ctx.projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      resolveRun({
        ran: true,
        exitCode: -1,
        output: stderr,
        reason: `spawn error: ${err.message}`,
      });
    });
    child.on('close', (code) => {
      const exitCode = code ?? -1;
      const ok = exitCode === 0;
      resolveRun({
        ran: true,
        exitCode,
        output: stdout + stderr,
        ...(ok ? {} : { reason: `complete-design exited with code ${exitCode}` }),
      });
    });
  });
}

/**
 * Run the post-council hook pipeline:
 *   1. AGENTS.MD auto-maintenance (can be skipped via ZELARI_AGENTS_MD=0).
 *   2. complete-design post-processor (design-phase only, can be skipped
 *      via ZELARI_COMPLETE_DESIGN=0).
 *
 * The `completeDesign` field carries the secondary result so the CLI can
 * surface it ("complete-design: 12 tasks + 1 milestone added"). The
 * primary `changed`/`sections` reflect the AGENTS.MD step only.
 *
 * Errors from either step are caught and reported in the result — the
 * hook never throws.
 */
export async function runPostCouncilHook(
  ctx: WorkspaceContext,
): Promise<PostCouncilHookResult> {
  // ── Step 1: AGENTS.MD maintenance ─────────────────────────────────────
  let agentsMdResult: HookResult;
  if (process.env['ZELARI_AGENTS_MD'] === '0') {
    agentsMdResult = {
      ran: false,
      changed: false,
      sections: [],
      reason: 'ZELARI_AGENTS_MD=0 (disabled)',
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
  const completeDesign = await runCompleteDesignPostProcessor(ctx);

  return {
    ran: agentsMdResult.ran || completeDesign.ran,
    changed: agentsMdResult.changed,
    sections: agentsMdResult.sections,
    ...(agentsMdResult.reason ? { reason: agentsMdResult.reason } : {}),
    completeDesign,
  };
}