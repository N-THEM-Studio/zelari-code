/**
 * worktreeCleanupBatch — Int3c (plan v2 §7.3) cleanup policy + queue.
 *
 * The per-worktree git calls live in `tools/krakenWorktree.ts`; this module
 * owns only the POLICY (`batch` vs `eager`) and the in-process QUEUE of
 * repo-level cleanup that a run defers. Split out because krakenWorktree.ts is
 * already at its size budget and the state here is unrelated to worktree
 * creation/merging.
 *
 * Why defer anything: removing a worktree used to cost three git processes —
 * `worktree remove --force` (must stay eager: the directory has to be free
 * before the next writer, and a merge node may run right after), then
 * `worktree prune`, then `branch -D <branch>`. Prune and branch deletion are
 * idempotent, order-independent and invisible to the run, so inside a run
 * scope they are coalesced into ONE `prune` + ONE `branch -D <list>` at the
 * end of the run.
 *
 * Scope, not "always": `cleanupKrakenWorktree` only defers while a scope is
 * open (`beginKrakenWorktreeCleanupBatch`). Outside one, nothing would ever
 * drain the queue — a standalone `task` call would silently keep its branches
 * — so cleanup stays eager there. The flag's default is still `batch`: every
 * run that opens a scope defers, `ZELARI_KRAKEN_WORKTREE_CLEANUP=eager` opts
 * out for all callers.
 *
 * Pure state + policy: no fs, no git, no clock. The caller does the spawning.
 *
 * @since v2.38.0 (Int3c)
 */

/** How the repo-level cleanup after a removed worktree is issued. */
export type KrakenWorktreeCleanupMode = 'batch' | 'eager';

/**
 * `ZELARI_KRAKEN_WORKTREE_CLEANUP`, default `batch` (plan v2 §13):
 *
 * `batch`  — inside a run scope, coalesce `worktree prune` + `branch -D` into
 *            ONE pair at the end of the run.
 * `eager`  — kill-switch: per-worktree `prune` + `branch -D`, exactly as
 *            before Int3c.
 *
 * An unrecognized value falls back to the default rather than to `eager`: a
 * typo must not silently re-enable the extra subprocesses the slice removed.
 */
export function resolveWorktreeCleanupMode(
  env: NodeJS.ProcessEnv = process.env,
): KrakenWorktreeCleanupMode {
  const v = (env.ZELARI_KRAKEN_WORKTREE_CLEANUP ?? '').trim().toLowerCase();
  if (v === 'eager') return 'eager';
  return 'batch';
}

/** repoRoot → the `worktree prune` it still owes (one per removed worktree). */
const pendingPruneRoots = new Set<string>();

/** repoRoot → branches whose worktree is gone but whose branch is not. */
const pendingBranches = new Map<string, Set<string>>();

/**
 * Open run scopes. A counter (not a boolean) so two concurrent scopes — an
 * executor run and, say, a nested one — cannot close each other's batch: each
 * `begin` is matched by one `take`, and a take already drains the whole queue
 * (deleting a queued branch earlier than "end of run" is only ever *more*
 * eager, never wrong).
 */
let batchScopes = 0;

/** True when `cleanupKrakenWorktree` should defer instead of cleaning eagerly. */
export function isKrakenWorktreeCleanupBatched(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return batchScopes > 0 && resolveWorktreeCleanupMode(env) === 'batch';
}

/**
 * Open the cleanup batch for a run. Returns whether deferral is active: false
 * in `eager` mode (nothing is queued, so the caller has no flush to make).
 */
export function beginKrakenWorktreeCleanupBatch(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (resolveWorktreeCleanupMode(env) !== 'batch') return false;
  batchScopes += 1;
  return true;
}

/**
 * Queue the repo-level half of one cleanup. Duplicates collapse: N worktrees
 * of the same repo cost one prune, and a branch name is unique per worktree
 * anyway (it embeds a timestamp + random id).
 */
export function queueWorktreeCleanup(repoRoot: string, branch: string | null): void {
  pendingPruneRoots.add(repoRoot);
  if (!branch) return;
  const queued = pendingBranches.get(repoRoot) ?? new Set<string>();
  queued.add(branch);
  pendingBranches.set(repoRoot, queued);
}

/** What a drain handed back to the caller (which then issues the git calls). */
export interface WorktreeCleanupQueue {
  /** Repo roots that had at least one worktree removed. */
  repoRoots: string[];
  /** repoRoot → the branch names to delete there. */
  branchesByRoot: Map<string, string[]>;
}

/**
 * Close one scope and drain the queue. Draining clears the state, so a second
 * drain in the same process returns empty work — the caller can issue no git
 * command for it (an idle flush costs zero spawns).
 */
export function takeQueuedWorktreeCleanup(): WorktreeCleanupQueue {
  if (batchScopes > 0) batchScopes -= 1;

  const repoRoots = new Set<string>([...pendingPruneRoots, ...pendingBranches.keys()]);
  const branchesByRoot = new Map<string, string[]>();
  for (const repoRoot of repoRoots) {
    const queued = pendingBranches.get(repoRoot);
    if (queued && queued.size > 0) branchesByRoot.set(repoRoot, [...queued]);
    pendingPruneRoots.delete(repoRoot);
    pendingBranches.delete(repoRoot);
  }

  return { repoRoots: [...repoRoots], branchesByRoot };
}

/** Test-only: drop the queue and any open scope. */
export function __resetKrakenWorktreeCleanupQueueForTests(): void {
  pendingPruneRoots.clear();
  pendingBranches.clear();
  batchScopes = 0;
}
