/**
 * checkpointManager — workspace snapshots + atomic rollback.
 *
 * A safety net for multi-file changes, especially autonomous Zelari missions:
 * take a snapshot of the working tree BEFORE a risky change, and restore the
 * tree exactly if it goes wrong.
 *
 * Design (git plumbing, zero side effects on the user's state):
 *   - snapshot: build a throwaway index (GIT_INDEX_FILE) seeded from HEAD,
 *     `git add -A` into it (captures tracked + untracked, honoring .gitignore),
 *     `write-tree` → tree, `commit-tree` → commit, and pin it under
 *     `refs/zelari/checkpoints/<id>` so git GC can't collect it. The user's
 *     real index, HEAD, branch, and stash list are never touched.
 *   - restore: point the real index at the snapshot tree, `checkout-index -a -f`
 *     to rewrite the working tree, then delete any files created since the
 *     snapshot. Result: working tree + index match the checkpoint exactly.
 *     HEAD/branch are left alone (a checkpoint is a working-tree state, not a
 *     commit on your history).
 *
 * The git refs ARE the persistence — no separate metadata file to drift.
 * Every git call is best-effort; failures surface as `{ error }`, never throws.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);

const REF_PREFIX = 'refs/zelari/checkpoints/';

export interface Checkpoint {
  /** Short id (also the ref suffix under refs/zelari/checkpoints/). */
  id: string;
  /** Human label. */
  label: string;
  /** Snapshot tree SHA. */
  tree: string;
  /** HEAD commit at snapshot time (null in an empty repo). */
  head: string | null;
  /** The pinned commit object wrapping the tree. */
  commit: string;
  /** Epoch ms the checkpoint was created. */
  createdAt: number;
}

export type CheckpointResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Run `git -C <cwd> <args>` with an optional env overlay. Throws on failure. */
async function git(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : process.env,
  });
  return stdout;
}

/** Best-effort variant: returns trimmed stdout or null on any error. */
async function gitSafe(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  try {
    return (await git(cwd, args, env)).trim();
  } catch {
    return null;
  }
}

/** True if `cwd` is inside a git working tree. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  return (await gitSafe(cwd, ['rev-parse', '--is-inside-work-tree'])) === 'true';
}

/** Run a block with a fresh throwaway index file, always cleaned up. */
async function withTempIndex<T>(fn: (indexFile: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), 'zelari-ckpt-'));
  const indexFile = path.join(dir, 'index');
  try {
    return await fn(indexFile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Capture the current working tree as a git tree object, using a throwaway
 * index so the real index is untouched. Returns { tree, head }.
 */
async function snapshotTree(cwd: string): Promise<{ tree: string; head: string | null }> {
  const head = await gitSafe(cwd, ['rev-parse', 'HEAD']);
  return withTempIndex(async (indexFile) => {
    const env = { GIT_INDEX_FILE: indexFile };
    // Seed the temp index from HEAD when the repo has commits; skip for an
    // empty repo (no HEAD) — `add -A` then captures everything from scratch.
    if (head) await git(cwd, ['read-tree', 'HEAD'], env);
    await git(cwd, ['add', '-A'], env);
    const tree = (await git(cwd, ['write-tree'], env)).trim();
    return { tree, head };
  });
}

/**
 * Create a checkpoint of the current working tree. Best-effort — returns
 * `{ ok:false, error }` if this is not a git repo or a git call fails.
 */
export async function createCheckpoint(
  cwd: string,
  label = 'checkpoint',
): Promise<CheckpointResult<Checkpoint>> {
  if (!(await isGitRepo(cwd))) {
    return { ok: false, error: 'not a git repository — checkpoints require git' };
  }
  try {
    const { tree, head } = await snapshotTree(cwd);
    const id = randomUUID().slice(0, 8);
    const createdAt = Date.now();
    const message = `zelari-checkpoint ${id}: ${label}`;
    // commit-tree with a parent when HEAD exists, else a root commit.
    const commitArgs = ['commit-tree', tree, '-m', message];
    if (head) commitArgs.push('-p', head);
    const commit = (await git(cwd, commitArgs)).trim();
    await git(cwd, ['update-ref', `${REF_PREFIX}${id}`, commit]);
    return { ok: true, value: { id, label, tree, head, commit, createdAt } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** List existing checkpoints, newest first. */
export async function listCheckpoints(cwd: string): Promise<Checkpoint[]> {
  const out = await gitSafe(cwd, [
    'for-each-ref',
    '--sort=-creatordate',
    '--format=%(refname) %(objectname) %(creatordate:unix) %(contents:subject)',
    REF_PREFIX,
  ]);
  if (!out) return [];
  const checkpoints: Checkpoint[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [refname, commit, unix, ...subjectParts] = line.split(' ');
    if (!refname?.startsWith(REF_PREFIX)) continue;
    const id = refname.slice(REF_PREFIX.length);
    const subject = subjectParts.join(' ');
    // Parse "zelari-checkpoint <id>: <label>" back into the label.
    const label = subject.replace(/^zelari-checkpoint\s+\S+:\s*/, '') || 'checkpoint';
    const tree = (await gitSafe(cwd, ['rev-parse', `${commit}^{tree}`])) ?? '';
    checkpoints.push({
      id,
      label,
      tree,
      head: null,
      commit: commit ?? '',
      createdAt: (Number(unix) || 0) * 1000,
    });
  }
  return checkpoints;
}

/** Return the most recent checkpoint, or null if there are none. */
export async function latestCheckpoint(cwd: string): Promise<Checkpoint | null> {
  return (await listCheckpoints(cwd))[0] ?? null;
}

export interface RestoreSummary {
  /** Checkpoint id restored. */
  id: string;
  /** Files created after the snapshot that were removed during restore. */
  deleted: string[];
}

/**
 * Restore the working tree (and index) to a checkpoint. Files modified or
 * deleted since the snapshot are reverted to the snapshot content; files
 * created since the snapshot are removed. HEAD/branch are left untouched.
 *
 * Best-effort — returns `{ ok:false, error }` on a missing checkpoint or any
 * git failure. Pass `id` to target a specific checkpoint; omit to use the
 * most recent one.
 */
export async function restoreCheckpoint(
  cwd: string,
  id?: string,
): Promise<CheckpointResult<RestoreSummary>> {
  if (!(await isGitRepo(cwd))) {
    return { ok: false, error: 'not a git repository — checkpoints require git' };
  }
  try {
    const target = id
      ? (await listCheckpoints(cwd)).find((c) => c.id === id)
      : await latestCheckpoint(cwd);
    if (!target) {
      return { ok: false, error: id ? `checkpoint "${id}" not found` : 'no checkpoints to restore' };
    }
    const snapTree = target.tree || (await gitSafe(cwd, ['rev-parse', `${target.commit}^{tree}`]));
    if (!snapTree) return { ok: false, error: 'could not resolve checkpoint tree' };

    // Files created since the snapshot (present now, absent in the snapshot)
    // must be deleted so the restore is exact. Compare the snapshot tree
    // against the current working-tree state.
    const current = await snapshotTree(cwd);
    const addedOut = await gitSafe(cwd, [
      'diff', '--name-only', '--diff-filter=A', snapTree, current.tree,
    ]);
    const added = addedOut ? addedOut.split('\n').filter((l) => l.trim()) : [];

    // Point the real index at the snapshot and rewrite the working tree to
    // match it (restores modified + recreates deleted files).
    await git(cwd, ['read-tree', snapTree]);
    await git(cwd, ['checkout-index', '-a', '-f']);

    // Remove files created after the snapshot.
    const deleted: string[] = [];
    for (const rel of added) {
      try {
        rmSync(path.join(cwd, rel), { force: true });
        deleted.push(rel);
      } catch {
        // Leave it; a partial cleanup is still better than a failed restore.
      }
    }
    return { ok: true, value: { id: target.id, deleted } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Delete a checkpoint ref (its objects are reclaimed by a later git gc). */
export async function dropCheckpoint(cwd: string, id: string): Promise<boolean> {
  return (await gitSafe(cwd, ['update-ref', '-d', `${REF_PREFIX}${id}`])) !== null;
}
