/**
 * transactional — checkpoint → run → keep-or-rollback wrapper (P2.D).
 *
 * Wraps one unit of work (a writer tentacle run) in a workspace transaction:
 *   1. checkpoint the working tree via `checkpointManager` (git plumbing only
 *      — HEAD, branch, index and stash are never touched);
 *   2. run the work;
 *   3. PASS    → keep the checkpoint as a recovery point, correlated to the
 *                task/node through the checkpoint label;
 *      FAIL    → restore the tree to the checkpoint and drop the ref, so a
 *                failed subagent never leaves a dirty workspace (a retry then
 *                starts from clean state);
 *      restore failure → surfaced honestly: the outcome is still `rolledback`
 *                but the error says the workspace may be dirty. Never swallowed.
 *
 * When no transaction is possible — not a git repo, or the checkpoint itself
 * fails to create — the work still runs (`passthrough`) with an honest `note`.
 * A passthrough run does NOT swallow errors: there is nothing to roll back,
 * so a throwing work rejects all the way out to the caller's ordinary error
 * handling.
 *
 * Concurrency note: the checkpoint/restore covers the WHOLE working tree, not
 * one node's write scope. Concurrent in-place writers sharing a tree (i.e.
 * worktree isolation off) can have a sibling's post-checkpoint writes reverted
 * by a rollback. Part of why this stays opt-in (default OFF) for v1.
 *
 * @since P2.D — transactional agent execution
 */

import {
  isGitRepo,
  createCheckpoint,
  restoreCheckpoint,
  dropCheckpoint,
} from '../checkpoint/checkpointManager.js';

/** How the wrapped run ended. */
export type TransactionalOutcome = 'success' | 'rolledback' | 'passthrough';

export interface TransactionalOptions {
  /** Working tree to snapshot, and to restore on failure. */
  cwd: string;
  /** Correlation: the task (graph) the run belongs to. Baked into the label. */
  taskId?: string;
  /** Correlation: the node within the task. Baked into the label. */
  nodeId?: string;
  /** Human label for the checkpoint. */
  label: string;
}

export interface TransactionalResult<T> {
  outcome: TransactionalOutcome;
  /** The work's value on `success` and `passthrough` (the work ran). */
  value?: T;
  /** On `rolledback`: why the work failed, plus how the rollback went. */
  error?: string;
  /** The recovery-point checkpoint id, when one was created. */
  checkpointId?: string;
  /** Honest note on `passthrough`: why the transaction was skipped. */
  note?: string;
}

/**
 * Correlated checkpoint label: `task=<id> node=<id> · <label>`.
 *
 * `Checkpoint` has no metadata slot — the git commit subject is the only
 * persisted annotation — so the correlation rides in the label: it survives
 * in the ref's commit message and comes back verbatim from
 * `listCheckpoints(...)[i].label`.
 */
export function correlatedLabel(opts: TransactionalOptions): string {
  const parts: string[] = [];
  if (opts.taskId) parts.push(`task=${opts.taskId}`);
  if (opts.nodeId) parts.push(`node=${opts.nodeId}`);
  return parts.length > 0 ? `${parts.join(' ')} · ${opts.label}` : opts.label;
}

/**
 * Run `fn` inside a workspace transaction: checkpoint → run → PASS keep /
 * FAIL rollback. Failure means `fn` threw (or rejected) — a resolved result
 * is a success by definition here; callers that get a failure *value* from
 * their work should map it to a throw before handing it over.
 */
export async function runTransactional<T>(
  opts: TransactionalOptions,
  fn: () => Promise<T>,
): Promise<TransactionalResult<T>> {
  // No git, no transaction — but the work must still happen. Errors propagate.
  if (!(await isGitRepo(opts.cwd))) {
    const value = await fn();
    return {
      outcome: 'passthrough',
      value,
      note: 'not a git repository — ran without a transaction (no checkpoint, no rollback)',
    };
  }

  const created = await createCheckpoint(opts.cwd, correlatedLabel(opts));
  if (!created.ok) {
    const value = await fn();
    return {
      outcome: 'passthrough',
      value,
      note: `checkpoint failed (${created.error}) — ran without a transaction`,
    };
  }
  const checkpointId = created.value.id;

  let value: T;
  try {
    value = await fn();
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    const restored = await restoreCheckpoint(opts.cwd, checkpointId);
    if (!restored.ok) {
      // Never swallow a failed restore: the caller must know the workspace
      // may be dirty. The checkpoint ref stays — it is the only way back.
      return {
        outcome: 'rolledback',
        error: `${cause} — RESTORE FAILED (${restored.error}); workspace may be dirty`,
        checkpointId,
      };
    }
    // Rollback done; drop the spent recovery point (best-effort — a stale ref
    // is clutter, not corruption).
    await dropCheckpoint(opts.cwd, checkpointId);
    const removed = restored.value.deleted.length;
    return {
      outcome: 'rolledback',
      error:
        `${cause} — rolled back to checkpoint ${checkpointId}` +
        (removed > 0
          ? ` (${removed} file${removed === 1 ? '' : 's'} created after the snapshot removed)`
          : ''),
      checkpointId,
    };
  }

  // PASS: keep the checkpoint as the recovery point for this task/node.
  return { outcome: 'success', value, checkpointId };
}
