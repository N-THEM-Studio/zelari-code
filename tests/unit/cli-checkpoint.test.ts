import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createCheckpoint,
  listCheckpoints,
  latestCheckpoint,
  restoreCheckpoint,
  dropCheckpoint,
  isGitRepo,
} from '../../src/cli/checkpoint/checkpointManager.js';

function gitInit(dir: string): void {
  const run = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  run('init');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  run('config', 'commit.gpgsign', 'false');
}

function commitAll(dir: string, msg: string): void {
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'commit', '-m', msg], { stdio: 'ignore' });
}

describe('checkpointManager', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'ckpt-repo-'));
    gitInit(repo);
    writeFileSync(path.join(repo, 'a.txt'), 'original-a\n');
    writeFileSync(path.join(repo, 'b.txt'), 'original-b\n');
    commitAll(repo, 'initial');
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('creates and lists a checkpoint', async () => {
    const created = await createCheckpoint(repo, 'before risky change');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.id).toMatch(/^[0-9a-f]{8}$/);

    const list = await listCheckpoints(repo);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(created.value.id);
    expect(list[0].label).toBe('before risky change');
    expect(list[0].tree).toMatch(/^[0-9a-f]{40}$/);

    const latest = await latestCheckpoint(repo);
    expect(latest?.id).toBe(created.value.id);
  });

  it('reverts a modified file on restore', async () => {
    await createCheckpoint(repo, 'cp');
    writeFileSync(path.join(repo, 'a.txt'), 'MUTATED\n');
    const res = await restoreCheckpoint(repo);
    expect(res.ok).toBe(true);
    expect(readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('original-a\n');
  });

  it('recreates a deleted file on restore', async () => {
    await createCheckpoint(repo, 'cp');
    rmSync(path.join(repo, 'b.txt'));
    expect(existsSync(path.join(repo, 'b.txt'))).toBe(false);
    const res = await restoreCheckpoint(repo);
    expect(res.ok).toBe(true);
    expect(readFileSync(path.join(repo, 'b.txt'), 'utf8')).toBe('original-b\n');
  });

  it('removes files created after the snapshot on restore', async () => {
    await createCheckpoint(repo, 'cp');
    writeFileSync(path.join(repo, 'new-file.txt'), 'created later\n');
    const res = await restoreCheckpoint(repo);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.deleted).toContain('new-file.txt');
    expect(existsSync(path.join(repo, 'new-file.txt'))).toBe(false);
  });

  it('captures untracked files at snapshot time and restores them', async () => {
    // Untracked file present at snapshot → restore must bring it back after deletion.
    writeFileSync(path.join(repo, 'untracked.txt'), 'u\n');
    await createCheckpoint(repo, 'cp');
    rmSync(path.join(repo, 'untracked.txt'));
    const res = await restoreCheckpoint(repo);
    expect(res.ok).toBe(true);
    expect(readFileSync(path.join(repo, 'untracked.txt'), 'utf8')).toBe('u\n');
  });

  it('restores a specific checkpoint by id', async () => {
    const first = await createCheckpoint(repo, 'first');
    writeFileSync(path.join(repo, 'a.txt'), 'v2\n');
    await createCheckpoint(repo, 'second');
    writeFileSync(path.join(repo, 'a.txt'), 'v3\n');

    if (!first.ok) throw new Error('setup failed');
    const res = await restoreCheckpoint(repo, first.value.id);
    expect(res.ok).toBe(true);
    // Restored to the FIRST checkpoint's content, not the latest.
    expect(readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('original-a\n');
  });

  it('errors on an unknown checkpoint id', async () => {
    const res = await restoreCheckpoint(repo, 'deadbeef');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not found/);
  });

  it('drops a checkpoint', async () => {
    const created = await createCheckpoint(repo, 'cp');
    if (!created.ok) throw new Error('setup failed');
    expect(await dropCheckpoint(repo, created.value.id)).toBe(true);
    expect(await listCheckpoints(repo)).toHaveLength(0);
  });

  it('reports an error outside a git repo', async () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'ckpt-plain-'));
    try {
      expect(await isGitRepo(plain)).toBe(false);
      const res = await createCheckpoint(plain, 'x');
      expect(res.ok).toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('does not create real commits or move HEAD', async () => {
    const headBefore = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await createCheckpoint(repo, 'cp');
    const headAfter = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(headAfter).toBe(headBefore);
    // The checkpoint ref lives under refs/zelari/checkpoints, not on any branch.
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list'], { encoding: 'utf8' });
    expect(branches).not.toMatch(/zelari/);
  });
});
