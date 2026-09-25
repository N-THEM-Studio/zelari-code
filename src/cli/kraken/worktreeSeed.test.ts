/**
 * worktreeSeed — real git, no mocks (post-mortem 2026-09-24).
 *
 * The contract pinned here:
 *   - a clean parent seeds nothing (the HEAD worktree stays as it was);
 *   - a dirty parent (staged + unstaged + untracked) is captured in a snapshot
 *     commit WITHOUT touching the parent's HEAD, index or files;
 *   - the full path — worktree from the snapshot, tentacle edit, merge-back —
 *     lands the tentacle's edit next to the user's uncommitted work, commits
 *     nothing and leaves the index alone;
 *   - a patch that no longer applies leaves the parent byte-identical.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createKrakenWorktreeDetailed,
  mergeKrakenWorktree,
  type WorktreeHandle,
} from '../tools/krakenWorktree.js';
import {
  applySeededWorktree,
  resolveWorktreeSeedMode,
  snapshotDirtyParent,
  type SeedGitRun,
} from './worktreeSeed.js';

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

const gitRun: SeedGitRun = async (cwd, args, opts) => {
  try {
    const stdout = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(opts?.env ? { env: opts.env } : {}),
    });
    return { ok: true, stdout, stderr: '', code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? String(err), code: e.status ?? 1 };
  }
};

let repo = '';
const read = (rel: string, root = repo) => readFileSync(path.join(root, rel), 'utf8');

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'zelari-seed-'));
  sh(repo, ['init', '-q', '-b', 'main']);
  sh(repo, ['config', 'user.email', 'test@zelari.local']);
  sh(repo, ['config', 'user.name', 'test']);
  sh(repo, ['config', 'core.autocrlf', 'false']);
  writeFileSync(path.join(repo, '.gitignore'), '.zelari/\n');
  writeFileSync(path.join(repo, 'page.html'), 'line 1\nline 2\nline 3\nline 4\n');
  writeFileSync(path.join(repo, 'staged.txt'), 'old\n');
  sh(repo, ['add', '-A']);
  sh(repo, ['commit', '-qm', 'init']);
});

afterEach(() => {
  try {
    sh(repo, ['worktree', 'prune']);
  } catch {
    /* repo may already be gone */
  }
  rmSync(repo, { recursive: true, force: true });
});

/** Uncommitted work of every kind: unstaged edit, staged edit, new file. */
function dirtyTheParent(): void {
  writeFileSync(path.join(repo, 'page.html'), 'line 1\nline 2 (lead, uncommitted)\nline 3\nline 4\n');
  writeFileSync(path.join(repo, 'staged.txt'), 'new\n');
  sh(repo, ['add', 'staged.txt']);
  writeFileSync(path.join(repo, 'fresh.md'), 'created by the lead\n');
}

describe('resolveWorktreeSeedMode', () => {
  it('seeds from the working tree unless ZELARI_KRAKEN_WORKTREE_SEED=head', () => {
    expect(resolveWorktreeSeedMode({})).toBe('dirty');
    expect(resolveWorktreeSeedMode({ ZELARI_KRAKEN_WORKTREE_SEED: 'whatever' })).toBe('dirty');
    expect(resolveWorktreeSeedMode({ ZELARI_KRAKEN_WORKTREE_SEED: ' HEAD ' })).toBe('head');
  });
});

describe('snapshotDirtyParent', () => {
  it('is a no-op on a clean tree', async () => {
    const head = sh(repo, ['rev-parse', 'HEAD']);
    expect(await snapshotDirtyParent(gitRun, repo, head)).toEqual({ kind: 'clean' });
  });

  it('captures staged, unstaged and untracked work without touching HEAD, index or files', async () => {
    dirtyTheParent();
    const head = sh(repo, ['rev-parse', 'HEAD']);
    const statusBefore = sh(repo, ['status', '--porcelain']);
    const pageBefore = read('page.html');

    const snap = await snapshotDirtyParent(gitRun, repo, head);
    expect(snap.kind).toBe('seeded');
    if (snap.kind !== 'seeded') return;

    // The snapshot holds exactly what the lead sees on disk…
    expect(sh(repo, ['show', `${snap.sha}:page.html`])).toContain('line 2 (lead, uncommitted)');
    expect(sh(repo, ['show', `${snap.sha}:staged.txt`])).toBe('new');
    expect(sh(repo, ['show', `${snap.sha}:fresh.md`])).toBe('created by the lead');
    expect(sh(repo, ['rev-parse', `${snap.sha}^`])).toBe(head);
    // …and the parent is untouched: same HEAD, same staged/unstaged split, same bytes.
    expect(sh(repo, ['rev-parse', 'HEAD'])).toBe(head);
    expect(sh(repo, ['status', '--porcelain'])).toBe(statusBefore);
    expect(read('page.html')).toBe(pageBefore);
    // The temporary index is gone.
    expect(sh(repo, ['status', '--porcelain', '--ignored'])).not.toContain('zelari-seed-');
  });
});

describe('seeded worktree end to end', () => {
  it('the writer sees the uncommitted file and its edit lands next to the lead work, uncommitted', async () => {
    dirtyTheParent();
    const head = sh(repo, ['rev-parse', 'HEAD']);

    const created = await createKrakenWorktreeDetailed(repo, 'refine page', {});
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const handle: WorktreeHandle = created.handle;
    expect(handle.seedSha).toBeTruthy();
    // The 2026-09-24 bug: the writer used to get the committed page.
    expect(read('page.html', handle.path)).toContain('line 2 (lead, uncommitted)');
    expect(read('fresh.md', handle.path)).toBe('created by the lead\n');

    // The tentacle edits a different line of the same file.
    writeFileSync(
      path.join(handle.path, 'page.html'),
      'line 1\nline 2 (lead, uncommitted)\nline 3\nline 4 (tentacle)\n',
    );

    const merge = await mergeKrakenWorktree(handle, { message: 'kraken: merge refine page' }, {});
    expect(merge).toMatchObject({ ok: true, merged: true, committed: false });

    // Both edits are on disk; nothing was committed; the index is unchanged.
    expect(read('page.html')).toBe('line 1\nline 2 (lead, uncommitted)\nline 3\nline 4 (tentacle)\n');
    expect(sh(repo, ['rev-parse', 'HEAD'])).toBe(head);
    expect(sh(repo, ['diff', '--cached', '--name-only'])).toBe('staged.txt');
    expect(sh(repo, ['worktree', 'list'])).not.toContain(handle.path.replace(/\\/g, '/'));
  });

  it('a patch that no longer applies leaves the parent byte-identical and keeps the branch', async () => {
    dirtyTheParent();
    const created = await createKrakenWorktreeDetailed(repo, 'conflicting', {});
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const handle = created.handle;

    writeFileSync(path.join(handle.path, 'page.html'), 'line 1\nline 2 (tentacle)\nline 3\nline 4\n');
    // Meanwhile the lead rewrites the very same line.
    writeFileSync(path.join(repo, 'page.html'), 'line 1\nline 2 (lead, second pass)\nline 3\nline 4\n');
    const pageBefore = read('page.html');

    const merge = await mergeKrakenWorktree(handle, { message: 'kraken: merge conflicting' }, {});
    expect(merge.ok).toBe(false);
    expect(merge.conflict).toBe(true);
    expect(merge.message).toContain('Parent tree left untouched');
    expect(merge.message).toContain(`git diff ${handle.seedSha} ${handle.branch}`);
    expect(read('page.html')).toBe(pageBefore);
    expect(sh(repo, ['branch', '--list', handle.branch])).toContain(handle.branch);
  });

  it('a clean parent keeps the HEAD start point (no seed)', async () => {
    const created = await createKrakenWorktreeDetailed(repo, 'clean', {});
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.handle.seedSha).toBeUndefined();
    expect(created.handle.baseSha).toBe(sh(repo, ['rev-parse', 'HEAD']));
  });

  it('ZELARI_KRAKEN_WORKTREE_SEED=head restores the HEAD start point on a dirty parent', async () => {
    dirtyTheParent();
    const created = await createKrakenWorktreeDetailed(repo, 'legacy', {
      ZELARI_KRAKEN_WORKTREE_SEED: 'head',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.handle.seedSha).toBeUndefined();
    expect(read('page.html', created.handle.path)).toBe('line 1\nline 2\nline 3\nline 4\n');
  });
});

describe('applySeededWorktree', () => {
  it('reports empty when the branch adds nothing on top of the seed', async () => {
    dirtyTheParent();
    const head = sh(repo, ['rev-parse', 'HEAD']);
    const snap = await snapshotDirtyParent(gitRun, repo, head);
    if (snap.kind !== 'seeded') throw new Error('expected a seed');
    sh(repo, ['branch', 'kraken/empty', snap.sha]);
    expect(await applySeededWorktree(gitRun, repo, snap.sha, 'kraken/empty')).toEqual({ kind: 'empty' });
  });
});
