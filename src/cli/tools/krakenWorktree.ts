/**
 * krakenWorktree — opt-in git worktree isolation for Kraken general tentacles (K7).
 *
 * Enable with ZELARI_KRAKEN_WORKTREE=1 (or "true").
 *
 * Flow:
 *   1. git worktree add <repo>/.zelari/worktrees/kraken-<id> -b kraken/<id>
 *   2. Run sub-agent with cwd = worktree path
 *   3. On success (default): squash-merge branch into parent HEAD, then cleanup
 *      - ZELARI_KRAKEN_WORKTREE_AUTO_MERGE=0 → skip merge (still cleanup unless KEEP)
 *      - ZELARI_KRAKEN_WORKTREE_KEEP=1 → never merge/cleanup (manual)
 *   4. On merge conflict: keep worktree + branch, report error in footer
 *
 * Int3c (plan v2 §7.3) — lifecycle micro-opts:
 *
 *   1. `git rev-parse --show-toplevel` is MEMOIZED per process (per resolved
 *      cwd): the toplevel of a given directory cannot change while we run, and
 *      every writer paid for that probe at creation time. Only positive
 *      answers are cached — see `resolveGitRoot` for why a null is re-probed.
 *
 *   2. The cleanup is now scoped: the per-writer `worktree remove --force`
 *      stays EAGER (the directory must be free before the next writer), while
 *      the repo-level bookkeeping that used to follow it — one
 *      `git worktree prune` + one `git branch -D <branch>` per removed
 *      worktree — is DEFERRED and coalesced into a single prune + a single
 *      `branch -D <list>` at the end of the run. Only a run that explicitly
 *      opens a scope (`beginKrakenWorktreeCleanupBatch`) defers: outside a
 *      scope nothing would ever flush the queue, so cleanup stays eager there
 *      rather than leaking branches.
 *      Kill-switch `ZELARI_KRAKEN_WORKTREE_CLEANUP=eager` (default `batch`)
 *      restores the old per-worktree behavior for every caller.
 *      Policy + queue live in `kraken/worktreeCleanupBatch.ts` (re-exported
 *      below); this module owns the git calls.
 *
 * Windows: Git for Windows worktree. Paths are absolute.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import {
  __resetKrakenWorktreeCleanupQueueForTests,
  isKrakenWorktreeCleanupBatched,
  queueWorktreeCleanup,
  takeQueuedWorktreeCleanup,
} from '../kraken/worktreeCleanupBatch.js';

/**
 * Cleanup policy + queue live in `kraken/worktreeCleanupBatch.ts` (Int3c):
 * re-exported here so worktree callers keep a single entry point.
 */
export {
  beginKrakenWorktreeCleanupBatch,
  isKrakenWorktreeCleanupBatched,
  resolveWorktreeCleanupMode,
  type KrakenWorktreeCleanupMode,
} from '../kraken/worktreeCleanupBatch.js';

const execFileAsync = promisify(execFile);

export interface WorktreeHandle {
  id: string;
  branch: string;
  path: string;
  repoRoot: string;
  /** HEAD sha at creation (merge base). */
  baseSha?: string;
}

export interface WorktreeMergeResult {
  ok: boolean;
  merged: boolean;
  committed: boolean;
  message: string;
  conflict?: boolean;
}

export function isKrakenWorktreeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.ZELARI_KRAKEN_WORKTREE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function shouldKeepWorktree(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.ZELARI_KRAKEN_WORKTREE_KEEP ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Auto-merge after a successful general tentacle.
 * Default ON when worktree is enabled and KEEP is off.
 * Set ZELARI_KRAKEN_WORKTREE_AUTO_MERGE=0 to disable.
 */
export function isKrakenWorktreeAutoMergeEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (shouldKeepWorktree(env)) return false;
  const v = (env.ZELARI_KRAKEN_WORKTREE_AUTO_MERGE ?? '1').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return true;
}

/**
 * What a batched cleanup actually did. Honest by construction: the counts are
 * the git invocations issued (and the branches git confirmed deleting), not an
 * estimate — nothing is reported that was not observed.
 */
export interface WorktreeCleanupBatchResult {
  /** `git worktree prune` invocations at flush (≤1 per repo root). */
  pruned: number;
  /** Branch names handed to the batched `git branch -D` (the request). */
  branches: string[];
  /** Of those, the ones git confirmed with `Deleted branch ...`. */
  deleted: string[];
  /** Repo roots the flush touched. */
  repoRoots: string[];
}

/**
 * Issue the deferred repo-level cleanup: one `git worktree prune` per repo
 * root that had a worktree removed, then one `git branch -D <list>` per root.
 *
 * Fail-open by construction: `git()` never throws, so a flush in a `finally`
 * can not mask the error the run is already propagating, and a repo whose
 * prune fails still gets its branch deletion attempted. Never issues a git
 * command when the queue is empty (flush on an idle/eager process = 0 spawns).
 */
export async function flushKrakenWorktreeCleanupBatch(): Promise<WorktreeCleanupBatchResult> {
  const { repoRoots, branchesByRoot } = takeQueuedWorktreeCleanup();

  const branches: string[] = [];
  const deleted: string[] = [];
  let pruned = 0;

  for (const repoRoot of repoRoots) {
    await git(repoRoot, ['worktree', 'prune']);
    pruned += 1;

    const list = branchesByRoot.get(repoRoot);
    if (list && list.length > 0) {
      branches.push(...list);
      const r = await git(repoRoot, ['branch', '-D', ...list]);
      for (const line of r.stdout.split('\n')) {
        const m = /^Deleted branch (\S+)/.exec(line.trim());
        if (m?.[1]) deleted.push(m[1]);
      }
    }
  }

  return { pruned, branches, deleted, repoRoots };
}

/** Test-only: drop the memo, the cleanup queue and any open scope. */
export function __resetKrakenWorktreeLifecycleForTests(): void {
  gitRootMemo.clear();
  __resetKrakenWorktreeCleanupQueueForTests();
}

async function git(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['-C', cwd, ...args], {
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, stdout: stdout ?? '', stderr: stderr ?? '', code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: number };
    return {
      ok: false,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? String(err),
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

/**
 * Int3c: `resolved cwd → git toplevel`. Module-level on purpose: every writer
 * of a run resolves the SAME parent cwd, and the answer cannot change under
 * us. Bounded by the number of distinct cwds a process touches (a handful).
 */
const gitRootMemo = new Map<string, string>();

/** Resolve git toplevel for worktree add.
 *
 * Int3c: memoized per resolved cwd. The toplevel of a directory is a property
 * of the filesystem layout, not of the run, so re-probing it for every writer
 * was pure subprocess cost. Negative answers are deliberately NOT cached: a
 * cwd that is not a repo yet (a fresh temp dir, or a run that includes
 * `git init`) can become one mid-process, and a cached null would silently
 * disable worktree isolation for the rest of the process.
 *
 * Callers that need the probe repeated (tests) can call
 * `__resetKrakenWorktreeLifecycleForTests()`.
 */
export async function resolveGitRoot(cwd: string): Promise<string | null> {
  const key = path.resolve(cwd);
  const memo = gitRootMemo.get(key);
  if (memo) return memo;

  const r = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!r.ok) return null;
  const root = r.stdout.trim();
  if (!root) return null;
  gitRootMemo.set(key, root);
  return root;
}

/**
 * Create an isolated worktree for a general tentacle.
 * Returns null if git unavailable or worktree add fails (caller falls back to shared cwd).
 */
export async function createKrakenWorktree(
  cwd: string,
  label?: string,
): Promise<WorktreeHandle | null> {
  const repoRoot = await resolveGitRoot(cwd);
  if (!repoRoot) return null;

  const head = await git(repoRoot, ['rev-parse', 'HEAD']);
  const baseSha = head.ok ? head.stdout.trim() : undefined;

  const id = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const slug =
    (label ?? 'task')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24) || 'task';
  const branch = `kraken/${slug}-${id}`;
  const wtRoot = path.join(repoRoot, '.zelari', 'worktrees');
  const wtPath = path.join(wtRoot, `kraken-${id}`);

  try {
    if (!existsSync(wtRoot)) mkdirSync(wtRoot, { recursive: true });
  } catch {
    return null;
  }

  const add = await git(repoRoot, ['worktree', 'add', '-b', branch, wtPath, 'HEAD']);
  if (!add.ok) {
    const add2 = await git(repoRoot, ['worktree', 'add', wtPath, 'HEAD']);
    if (!add2.ok) return null;
    return { id, branch: 'HEAD', path: wtPath, repoRoot, baseSha };
  }

  return { id, branch, path: wtPath, repoRoot, baseSha };
}

/**
 * Commit dirty files inside the worktree (best-effort).
 */
export async function commitWorktreeChanges(
  handle: WorktreeHandle,
  message: string,
): Promise<{ ok: boolean; committed: boolean; detail: string }> {
  const st = await git(handle.path, ['status', '--porcelain']);
  if (!st.ok) return { ok: false, committed: false, detail: st.stderr || 'status failed' };

  if (st.stdout.trim()) {
    const add = await git(handle.path, ['add', '-A']);
    if (!add.ok) return { ok: false, committed: false, detail: add.stderr || 'add failed' };
    const msg = message.slice(0, 200) || `kraken tentacle ${handle.id}`;
    const commit = await git(handle.path, [
      'commit',
      '-m',
      msg,
      '--author',
      'Kraken Tentacle <kraken@zelari.local>',
    ]);
    if (!commit.ok) {
      const st2 = await git(handle.path, ['status', '--porcelain']);
      if (st2.ok && !st2.stdout.trim()) {
        return { ok: true, committed: false, detail: 'clean after add' };
      }
      return { ok: false, committed: false, detail: commit.stderr || 'commit failed' };
    }
    return { ok: true, committed: true, detail: 'committed in worktree' };
  }

  return { ok: true, committed: false, detail: 'worktree clean' };
}

/**
 * Squash-merge tentacle branch into the parent repo HEAD, then optionally cleanup.
 */
export async function mergeKrakenWorktree(
  handle: WorktreeHandle,
  opts: { message?: string; cleanup?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorktreeMergeResult> {
  if (!handle.branch || handle.branch === 'HEAD') {
    return {
      ok: false,
      merged: false,
      committed: false,
      message: 'worktree has no named branch to merge',
    };
  }

  const commitMsg = (opts.message ?? `kraken: merge ${handle.branch}`).slice(0, 200);

  const pre = await commitWorktreeChanges(handle, commitMsg);
  if (!pre.ok) {
    return {
      ok: false,
      merged: false,
      committed: false,
      message: `pre-merge commit failed: ${pre.detail}`,
    };
  }

  const range = handle.baseSha
    ? `${handle.baseSha}..${handle.branch}`
    : handle.branch;
  const log = await git(handle.repoRoot, ['log', '--oneline', range]);
  const ahead = log.ok ? log.stdout.trim() : '';
  if (!ahead && !pre.committed) {
    if (opts.cleanup !== false && !shouldKeepWorktree(env)) {
      await cleanupKrakenWorktree(handle, env);
    }
    return {
      ok: true,
      merged: false,
      committed: false,
      message: 'no changes to merge (worktree empty)',
    };
  }

  const merge = await git(handle.repoRoot, ['merge', '--squash', handle.branch]);
  if (!merge.ok) {
    const conflict =
      /conflict/i.test(merge.stderr) || /conflict/i.test(merge.stdout);
    if (conflict) {
      await git(handle.repoRoot, ['reset', '--merge']);
    }
    return {
      ok: false,
      merged: false,
      committed: false,
      conflict: true,
      message: `merge conflict or failed: ${(merge.stderr || merge.stdout).trim().slice(0, 300)}`,
    };
  }

  const stParent = await git(handle.repoRoot, ['status', '--porcelain']);
  let committed = false;
  if (stParent.ok && stParent.stdout.trim()) {
    const c = await git(handle.repoRoot, ['commit', '-m', commitMsg]);
    if (!c.ok) {
      return {
        ok: false,
        merged: true,
        committed: false,
        message: `squash staged but commit failed: ${c.stderr.slice(0, 200)}`,
      };
    }
    committed = true;
  }

  if (opts.cleanup !== false && !shouldKeepWorktree(env)) {
    await cleanupKrakenWorktree(handle, env);
  }

  return {
    ok: true,
    merged: true,
    committed,
    message: committed
      ? `squash-merged ${handle.branch} into HEAD`
      : `squash-merge ${handle.branch} (no parent commit — already applied?)`,
  };
}

/**
 * Remove worktree + delete branch (best-effort).
 * Skipped when ZELARI_KRAKEN_WORKTREE_KEEP=1.
 *
 * Int3c split: the `worktree remove --force` (plus the filesystem sweep) is
 * ALWAYS eager — the directory has to be gone before the next writer, and a
 * merge node may run right after. Only the repo-level bookkeeping is
 * deferred when a run scope is open: one `worktree prune` and one
 * `branch -D` per worktree become a single pair at flush time.
 */
export async function cleanupKrakenWorktree(
  handle: WorktreeHandle,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (shouldKeepWorktree(env)) return;

  await git(handle.repoRoot, ['worktree', 'remove', '--force', handle.path]);
  try {
    if (existsSync(handle.path)) {
      rmSync(handle.path, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }

  const branch = handle.branch.startsWith('kraken/') ? handle.branch : null;

  if (isKrakenWorktreeCleanupBatched(env)) {
    // Queue instead of spawning: prune is idempotent and order-independent
    // (it drops the admin entries of worktrees already removed), and the
    // branch is unreachable once its worktree is gone, so deferring both to
    // the end of the run changes nothing except the subprocess count.
    queueWorktreeCleanup(handle.repoRoot, branch);
    return;
  }

  await git(handle.repoRoot, ['worktree', 'prune']);
  if (branch) {
    await git(handle.repoRoot, ['branch', '-D', branch]);
  }
}

/** One-line status for task result footer. */
export function formatWorktreeFooter(
  handle: WorktreeHandle,
  opts: { kept?: boolean; merge?: WorktreeMergeResult | null } = {},
): string {
  const merge = opts.merge;
  if (merge) {
    const flag = merge.ok ? 'ok' : merge.conflict ? 'CONFLICT' : 'fail';
    return `worktree merge [${flag}]: ${merge.message} (branch=${handle.branch})`;
  }
  if (opts.kept) {
    return `worktree kept: branch=${handle.branch} path=${handle.path} (merge manually, then git worktree remove)`;
  }
  return `worktree used: branch=${handle.branch} path=${handle.path}`;
}
