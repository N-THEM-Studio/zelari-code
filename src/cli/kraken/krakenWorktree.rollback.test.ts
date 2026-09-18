/**
 * K2.3 / F11 — worktree squash-merge rollback — tests.
 *
 * Real temp git repos (execFile git, like the other worktree/checkpoint
 * suites): the whole point is the PARENT TREE state after an aborted merge,
 * which a stubbed `git` could not observe. Every test starts from a fresh
 * module cache.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  __resetKrakenWorktreeLifecycleForTests,
  createKrakenWorktree,
  mergeKrakenWorktree,
  type WorktreeHandle,
} from '../tools/krakenWorktree.js';
import { readKrakenRadio } from '../tools/krakenRadio.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** `git status --porcelain`, newline-normalised for a cross-platform compare. */
function porcelain(repo: string): string {
  return git(repo, 'status', '--porcelain').replace(/\r\n/g, '\n').trim();
}

/** `kraken/*` branches currently present in the repo. */
function krakenBranches(repo: string): string[] {
  return git(repo, 'branch', '--list', 'kraken/*')
    .split('\n')
    .map((l) => l.replace(/^[*+]\s*/, '').trim())
    .filter(Boolean);
}

/**
 * Make the NEXT commit fail deterministically: sign with a gpg program that
 * does not exist, so git refuses to write the commit object (exit 128). In
 * the commit-failure test the worktree change is pre-committed by the test, so
 * ONLY the parent squash commit is affected.
 */
function breakNextCommit(repo: string): void {
  git(repo, 'config', 'commit.gpgsign', 'true');
  git(repo, 'config', 'gpg.program', 'no-such-gpg-binary-k23');
}

describe('K2.3 — worktree squash-merge rollback (F11)', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'kraken-wt-rollback-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'kraken@zelari.local');
    git(repo, 'config', 'user.name', 'Kraken Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    // Keep the isolation scratch dir out of porcelain, exactly as the real
    // repo's .gitignore does (otherwise `.zelari/worktrees/` is untracked and
    // the pre-merge snapshot is never "clean").
    writeFileSync(path.join(repo, '.gitignore'), '.zelari/\n');
    writeFileSync(path.join(repo, 'base.txt'), 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    __resetKrakenWorktreeLifecycleForTests();
  });

  afterEach(() => {
    __resetKrakenWorktreeLifecycleForTests();
    // win32: a git child can still hold the dir handle for an instant after
    // exit — fs.rm retries are Node's canonical remedy for EBUSY/EPERM.
    rmSync(repo, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  it('commit failure after the squash → parent restored + worktree.merge_aborted', async () => {
    const handle = (await createKrakenWorktree(repo, 'rollback')) as WorktreeHandle;
    expect(handle).toBeTruthy();

    // A real change on the tentacle branch, committed in the worktree so its
    // pre-merge commit is a clean no-op and ONLY the PARENT commit runs.
    writeFileSync(path.join(handle.path, 'tentacle.txt'), 'from tentacle\n');
    git(handle.path, 'add', '-A');
    git(handle.path, 'commit', '-q', '-m', 'tentacle work');

    breakNextCommit(repo);

    const before = porcelain(repo);
    expect(before).toBe('');

    const result = await mergeKrakenWorktree(
      handle,
      { message: 'kraken: rollback probe', sessionId: 'k23-commit' },
      {},
    );

    expect(result.ok).toBe(false);
    expect(result.committed).toBe(false);
    expect(result.merged).toBe(true);

    // (a) parent porcelain identical to the pre-merge snapshot (fully clean).
    expect(porcelain(repo)).toBe(before);

    // The abort event is on the session radio.
    const events = readKrakenRadio(repo, 'k23-commit');
    const aborted = events.filter((e) => e.description === 'worktree.merge_aborted');
    expect(aborted.length).toBeGreaterThan(0);
    const last = aborted[aborted.length - 1];
    expect(last?.kind).toBe('error');
    expect(last?.worktree).toBe(handle.branch);

    // (b) branch + worktree survive the abort (never cleaned up).
    expect(krakenBranches(repo)).toContain(handle.branch);
    expect(existsSync(handle.path)).toBe(true);
  });

  it('pre-merge commit failure (no parent mutation) → abort recorded, parent untouched', async () => {
    const handle = (await createKrakenWorktree(repo, 'precommit')) as WorktreeHandle;
    // Pending uncommitted edit in the worktree: the WORKTREE commit is the one
    // that fails, before any parent mutation.
    writeFileSync(path.join(handle.path, 'pending.txt'), 'pending\n');
    breakNextCommit(repo);

    const before = porcelain(repo);

    const result = await mergeKrakenWorktree(
      handle,
      { message: 'kraken: pre-commit probe', sessionId: 'k23-pre' },
      {},
    );

    expect(result.ok).toBe(false);
    expect(result.merged).toBe(false);
    expect(porcelain(repo)).toBe(before);

    const events = readKrakenRadio(repo, 'k23-pre');
    expect(events.some((e) => e.description === 'worktree.merge_aborted')).toBe(true);
    expect(krakenBranches(repo)).toContain(handle.branch);
  });

  it('conflict → branch kept, parent restored, conflict surfaced (no regression)', async () => {
    writeFileSync(path.join(repo, 'conflict.txt'), 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'add conflict.txt');

    const handle = (await createKrakenWorktree(repo, 'conflict')) as WorktreeHandle;
    writeFileSync(path.join(handle.path, 'conflict.txt'), 'branch\n');

    // Diverge the parent on the SAME file → the squash must conflict.
    writeFileSync(path.join(repo, 'conflict.txt'), 'parent\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'parent diverges');

    const before = porcelain(repo);

    const result = await mergeKrakenWorktree(
      handle,
      { message: 'kraken: conflict probe', sessionId: 'k23-conflict' },
      {},
    );

    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    // Parent restored to its pre-merge (clean) state — no half-merged tree.
    expect(porcelain(repo)).toBe(before);
    // Branch (and worktree) kept for manual recovery.
    expect(krakenBranches(repo)).toContain(handle.branch);
    expect(existsSync(handle.path)).toBe(true);
    // And the abort is on the radio too.
    const events = readKrakenRadio(repo, 'k23-conflict');
    expect(events.some((e) => e.description === 'worktree.merge_aborted')).toBe(true);
  });
});
