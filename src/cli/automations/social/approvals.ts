/**
 * automations/social/approvals.ts — the human-approval inbox (F2).
 *
 * `listPending` projects every `awaiting_approval` run across automations;
 * `resolveApproval` records one decision (allow|deny|edit) and, unless denied or
 * expired, hands the run to the dry-run publisher. TTL expiry is enforced here
 * so a stale draft can never be published after the fact (P1).
 */
import { findRun, getAutomation, listAllRuns, writeRun } from '../registry.js';
import type { AutomationRun } from '../types.js';
import { DEFAULT_TTL_MIN, publishDraft } from './runner.js';

/** Preview length for the pending inbox (chars of draft text). */
export const PREVIEW_CHARS = 120;

/** One pending approval row. */
export interface PendingApproval {
  automationId: string;
  runId: string;
  startedAt: string;
  /** Effective expiry (stored, or startedAt + default TTL). */
  expiresAt?: string;
  draftPreview: string;
}

/** The run's stored expiresAt, else startedAt + default TTL. */
function effectiveExpiry(run: AutomationRun): string | undefined {
  if (run.expiresAt) return run.expiresAt;
  const t = Date.parse(run.startedAt);
  if (!Number.isFinite(t)) return undefined;
  return new Date(t + DEFAULT_TTL_MIN * 60_000).toISOString();
}

/** Every run across automations currently awaiting a human decision. */
export async function listPending(root: string): Promise<PendingApproval[]> {
  const runs = await listAllRuns(root);
  return runs
    .filter((r) => r.status === 'awaiting_approval')
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
    .map((r) => ({
      automationId: r.automationId,
      runId: r.runId,
      startedAt: r.startedAt,
      expiresAt: effectiveExpiry(r),
      draftPreview: (r.draft?.text ?? '').slice(0, PREVIEW_CHARS),
    }));
}

/** Persist a terminal (non-publishing) outcome. */
async function finish(root: string, run: AutomationRun): Promise<number> {
  run.finishedAt = new Date().toISOString();
  await writeRun(root, run);
  return run.exitCode;
}

/**
 * Resolve one pending run. Returns the process exit code:
 *   4 expired (skipped), 0 denied (skipped), else the publish exit code.
 * An unknown runId is an error (1).
 */
export async function resolveApproval(
  root: string,
  runId: string,
  decision: 'allow' | 'deny' | 'edit',
  editedText?: string,
): Promise<number> {
  const run = await findRun(root, runId);
  if (!run) {
    process.stderr.write(`[automation approve] unknown runId: ${runId}\n`);
    return 1;
  }

  const expiry = effectiveExpiry(run);
  if (expiry && Date.now() > Date.parse(expiry)) {
    run.status = 'skipped';
    run.reason = 'approval_ttl_expired';
    run.exitCode = 4;
    await finish(root, run);
    process.stderr.write(`[automation approve] runId=${runId} expired at ${expiry}\n`);
    return 4;
  }

  run.approvals = [
    ...(run.approvals ?? []),
    decision === 'edit' && editedText !== undefined
      ? { at: new Date().toISOString(), decision, editedText }
      : { at: new Date().toISOString(), decision },
  ];

  if (decision === 'deny') {
    run.status = 'skipped';
    run.reason = 'denied_by_human';
    run.exitCode = 0;
    await finish(root, run);
    process.stdout.write(`[automation approve] runId=${runId} denied\n`);
    return 0;
  }

  if (decision === 'edit') {
    run.draft = { ...(run.draft ?? { text: '' }), text: editedText ?? run.draft?.text ?? '' };
  }

  const spec = await getAutomation(root, run.automationId);
  if (!spec) {
    run.status = 'failed';
    run.reason = 'automation_spec_missing';
    run.exitCode = 1;
    await finish(root, run);
    process.stderr.write(`[automation approve] spec missing for ${run.automationId}\n`);
    return 1;
  }

  return await publishDraft(root, run, spec);
}
