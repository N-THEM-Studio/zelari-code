/**
 * automations/runAutomation.ts — runtime dispatch (ADR-0037 §3).
 *
 * Entry point behind `automation run --id <id>` AND the OS launcher's
 * `zelari-code --headless --once --automation <id>`. Never throws across the
 * boundary: every failure path returns a numeric exit code and is persisted as
 * a run record.
 *
 *   gardener     → spawn the CLI headless in plan/propose-only mode (replicates
 *                  scripts/zelari-gardener.sh). Exit 0 ⇒ completed.
 *   social_post  → F2 (ADR-0037): the draft → approve → dry-run publish runner
 *                  (see social/runner.ts). Owns its own run creation.
 *
 * Exit codes: 0 ok, 1 error, 4 unproven/needs-attention (P1 — never a phantom
 * success).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ensureGardenerSpec } from './gardenerMigration.js';
import { getAutomation, newRunId, writeRun } from './registry.js';
import { runSocialPost } from './social/runner.js';
import type { AutomationRun } from './types.js';

/**
 * Propose-only gardener task. scripts/zelari-gardener.sh prepends a computed
 * `$REASON` (git/CI work detection); F1 keeps the flags/instruction verbatim
 * but does not replicate that detection, so the reason is generic.
 */
export const GARDENER_TASK =
  '[gardener] scheduled run. Propose-only: investigate, verify against the repo, ' +
  'and report concrete next steps — do not commit, merge or push.';

/**
 * Test-only seam: `ZELARI_AUTOMATION_RUNNER_STUB_EXIT=<int>` short-circuits the
 * gardener child spawn and returns the given exit code. Documented, no effect
 * when unset — keeps the runner testable without launching the real CLI.
 */
function stubbedExit(): number | undefined {
  const raw = process.env.ZELARI_AUTOMATION_RUNNER_STUB_EXIT;
  if (raw === undefined || raw === '') return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Spawn the CLI headless (plan/propose-only) and resolve with its exit code. */
function runGardener(root: string): Promise<number> {
  const stub = stubbedExit();
  if (stub !== undefined) return Promise.resolve(stub);
  const cliEntry = path.join(root, 'bin', 'zelari-code.js');
  const argv = [
    '--headless',
    '--once',
    '--mode',
    'zelari',
    '--phase',
    'plan',
    '--output',
    'plain',
    '--task',
    GARDENER_TASK,
  ];
  return new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [cliEntry, ...argv], { cwd: root, stdio: 'inherit' });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** Run one automation by id. Returns the process exit code (0/1/4). */
export async function runAutomation(root: string, id: string): Promise<number> {
  try {
    await ensureGardenerSpec(root);
    const spec = await getAutomation(root, id);
    if (!spec) {
      process.stderr.write(`[automation] unknown automation id: ${id}\n`);
      return 1;
    }

    // Disabled automations NEVER run: record an honest `skipped` run (exit 4)
    // instead of silently succeeding or spawning a child. Applies to every kind.
    if (!spec.enabled) {
      await writeRun(root, {
        runId: newRunId(),
        automationId: id,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: 'skipped',
        reason: 'disabled',
        exitCode: 4,
      });
      return 4;
    }

    // social_post owns its run lifecycle (drafting → … → completed|failed).
    if (spec.kind === 'social_post') {
      return await runSocialPost(root, spec);
    }

    const run: AutomationRun = {
      runId: newRunId(),
      automationId: id,
      startedAt: new Date().toISOString(),
      status: 'drafting',
      exitCode: 0,
    };
    await writeRun(root, run);

    const code = await runGardener(root);
    run.finishedAt = new Date().toISOString();
    if (code === 0) {
      run.status = 'completed';
      run.exitCode = 0;
    } else {
      run.status = 'failed';
      run.exitCode = 1;
      run.draft = { text: GARDENER_TASK, warnings: [`gardener child exited ${code}`] };
    }
    await writeRun(root, run);
    return run.exitCode;
  } catch (err) {
    process.stderr.write(
      `[automation] ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}
