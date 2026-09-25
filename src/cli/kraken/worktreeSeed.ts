/**
 * worktreeSeed — start a Kraken writer from the tree the lead actually sees.
 *
 * Post-mortem 2026-09-24 (session a27eb8fe): `git worktree add … HEAD` handed
 * each general tentacle the LAST COMMIT, not the working tree. The lead had
 * just written an uncommitted `index.html`; the writers opened the old
 * committed file (one looped on "your file lives outside my worktree"), and
 * the squash merge back then collided with that same uncommitted file, was
 * rolled back, and the tentacle's work never reached the parent tree.
 *
 * Two halves, git plumbing only (no new dependency):
 *
 *   1. `snapshotDirtyParent` — when the parent tree has uncommitted changes
 *      (staged, unstaged, or untracked and not ignored), write them into a
 *      commit object through a TEMPORARY index file. The parent's real index,
 *      its HEAD and its files are never touched. The worktree starts from that
 *      commit, so the writer sees exactly what the lead sees.
 *
 *   2. `applySeededWorktree` — a seeded worktree comes back as a patch of the
 *      tentacle's OWN edits (`seed..branch`) applied to the parent working
 *      tree with `git apply`: atomic (every hunk or none), no index, no
 *      commit, no reset. The user's uncommitted work is never swept into a
 *      Kraken commit and never rolled back; a patch that no longer applies
 *      leaves the parent byte-identical and the work on its branch.
 *
 * `ZELARI_KRAKEN_WORKTREE_SEED=head` restores the pre-fix behaviour (worktree
 * from HEAD, squash merge back).
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type SeedGitRun = (
  cwd: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv },
) => Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>;

export type WorktreeSeedMode = 'dirty' | 'head';

/** `head` is the only opt-out spelling; anything else seeds from the working tree. */
export function resolveWorktreeSeedMode(env: NodeJS.ProcessEnv = process.env): WorktreeSeedMode {
  return (env.ZELARI_KRAKEN_WORKTREE_SEED ?? '').trim().toLowerCase() === 'head' ? 'head' : 'dirty';
}

export type SnapshotResult =
  | { kind: 'clean' }
  | { kind: 'seeded'; sha: string; changedPaths: number }
  | { kind: 'failed'; reason: string };

export type SeedApplyResult =
  | { kind: 'empty' }
  | { kind: 'applied'; files: number }
  | { kind: 'rejected'; reason: string }
  | { kind: 'failed'; reason: string };

const SEED_MESSAGE = 'kraken: parent working-tree snapshot (worktree seed)';

/** commit-tree needs an identity; a repo without user.name must still seed. */
const SEED_IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'Kraken Tentacle',
  GIT_AUTHOR_EMAIL: 'kraken@zelari.local',
  GIT_COMMITTER_NAME: 'Kraken Tentacle',
  GIT_COMMITTER_EMAIL: 'kraken@zelari.local',
};

function short(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, 300);
}

/**
 * Snapshot the parent's uncommitted state as a commit whose parent is
 * `headSha`. `clean` when there is nothing to carry (the caller keeps the
 * plain HEAD worktree); `failed` when the tree is dirty but could not be
 * captured — the caller must NOT hand the writer a stale HEAD tree then.
 */
export async function snapshotDirtyParent(
  git: SeedGitRun,
  repoRoot: string,
  headSha: string,
): Promise<SnapshotResult> {
  const status = await git(repoRoot, ['status', '--porcelain', '--untracked-files=normal']);
  if (!status.ok) return { kind: 'failed', reason: `git status failed: ${short(status.stderr)}` };
  const changedPaths = status.stdout.split('\n').filter((line) => line.trim()).length;
  if (changedPaths === 0) return { kind: 'clean' };

  const gitDirOut = await git(repoRoot, ['rev-parse', '--git-dir']);
  if (!gitDirOut.ok) {
    return { kind: 'failed', reason: `git rev-parse --git-dir failed: ${short(gitDirOut.stderr)}` };
  }
  const gitDir = path.resolve(repoRoot, gitDirOut.stdout.trim());
  const tmpIndex = path.join(gitDir, `zelari-seed-${randomBytes(4).toString('hex')}.index`);
  const indexEnv: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    // Start from a COPY of the real index (keeps git's stat cache, so only
    // changed files are re-hashed); a repo without one starts from HEAD.
    const realIndex = path.join(gitDir, 'index');
    if (existsSync(realIndex)) {
      await copyFile(realIndex, tmpIndex);
    } else {
      const readTree = await git(repoRoot, ['read-tree', headSha], { env: indexEnv });
      if (!readTree.ok) return { kind: 'failed', reason: `git read-tree failed: ${short(readTree.stderr)}` };
    }
    const add = await git(repoRoot, ['add', '-A'], { env: indexEnv });
    if (!add.ok) return { kind: 'failed', reason: `git add -A failed: ${short(add.stderr)}` };
    const tree = await git(repoRoot, ['write-tree'], { env: indexEnv });
    if (!tree.ok || !tree.stdout.trim()) {
      return { kind: 'failed', reason: `git write-tree failed: ${short(tree.stderr)}` };
    }
    const commit = await git(
      repoRoot,
      ['commit-tree', tree.stdout.trim(), '-p', headSha, '-m', SEED_MESSAGE],
      { env: { ...process.env, ...SEED_IDENTITY } },
    );
    if (!commit.ok || !commit.stdout.trim()) {
      return { kind: 'failed', reason: `git commit-tree failed: ${short(commit.stderr)}` };
    }
    return { kind: 'seeded', sha: commit.stdout.trim(), changedPaths };
  } catch (err) {
    return { kind: 'failed', reason: err instanceof Error ? err.message : String(err) };
  } finally {
    await rm(tmpIndex, { force: true }).catch(() => {});
  }
}

/**
 * Bring a seeded worktree's own edits (`seedSha..branch`, already committed
 * in the worktree) back onto the parent working tree. `git apply` without
 * `--index` touches files only, and is all-or-nothing: `rejected` means the
 * parent is exactly as it was before the call.
 */
export async function applySeededWorktree(
  git: SeedGitRun,
  repoRoot: string,
  seedSha: string,
  branch: string,
): Promise<SeedApplyResult> {
  const patch = path.join(os.tmpdir(), `zelari-kraken-${randomBytes(6).toString('hex')}.patch`);
  try {
    const diff = await git(repoRoot, [
      'diff',
      '--binary',
      '--full-index',
      `--output=${patch}`,
      seedSha,
      branch,
    ]);
    if (!diff.ok) return { kind: 'failed', reason: `git diff failed: ${short(diff.stderr)}` };
    const size = (await stat(patch).catch(() => null))?.size ?? 0;
    if (size === 0) return { kind: 'empty' };

    const names = await git(repoRoot, ['diff', '--name-only', seedSha, branch]);
    const files = names.ok ? names.stdout.split('\n').filter((l) => l.trim()).length : 0;

    const check = await git(repoRoot, ['apply', '--check', '--whitespace=nowarn', patch]);
    if (!check.ok) return { kind: 'rejected', reason: short(check.stderr || check.stdout) };
    const apply = await git(repoRoot, ['apply', '--whitespace=nowarn', patch]);
    if (!apply.ok) return { kind: 'rejected', reason: short(apply.stderr || apply.stdout) };
    return { kind: 'applied', files };
  } catch (err) {
    return { kind: 'failed', reason: err instanceof Error ? err.message : String(err) };
  } finally {
    await rm(patch, { force: true }).catch(() => {});
  }
}

/** The one command a human (or the lead) runs to recover a rejected patch. */
export function seedRecoveryCommand(seedSha: string, branch: string): string {
  return `git diff ${seedSha} ${branch} | git apply --3way`;
}
