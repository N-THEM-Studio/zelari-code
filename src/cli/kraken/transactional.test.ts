import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { correlatedLabel, runTransactional } from './transactional.js';
import { listCheckpoints, dropCheckpoint } from '../checkpoint/checkpointManager.js';

// Spy wrapper: real implementation by default, so the fixture tests below
// exercise the actual git plumbing — but the createCheckpoint-failure branch
// can be forced deterministically with mockResolvedValueOnce.
vi.mock('../checkpoint/checkpointManager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../checkpoint/checkpointManager.js')>();
  return { ...actual, createCheckpoint: vi.fn(actual.createCheckpoint) };
});

function gitInit(dir: string): void {
  const run = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  run('init');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  run('config', 'commit.gpgsign', 'false');
  // Byte-exact restores on Windows (mirrors cli-checkpoint.test.ts).
  run('config', 'core.autocrlf', 'false');
}

function commitAll(dir: string, msg: string): void {
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'commit', '-m', msg], { stdio: 'ignore' });
}

describe('runTransactional', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'tx-repo-'));
    gitInit(repo);
    writeFileSync(path.join(repo, 'seed.txt'), 'original\n');
    commitAll(repo, 'initial');
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('success keeps the checkpoint as a correlated recovery point', async () => {
    const res = await runTransactional(
      { cwd: repo, taskId: 'task-1', nodeId: 'node-1', label: 'before writer run' },
      async () => {
        writeFileSync(path.join(repo, 'out.txt'), 'work\n');
        return 'did work';
      },
    );
    expect(res.outcome).toBe('success');
    expect(res.value).toBe('did work');
    expect(res.checkpointId).toMatch(/^[0-9a-f]{8}$/);
    // The work survives…
    expect(readFileSync(path.join(repo, 'out.txt'), 'utf8')).toBe('work\n');
    // …and the recovery point stays, correlated to task/node.
    const cps = await listCheckpoints(repo);
    expect(cps).toHaveLength(1);
    expect(cps[0].id).toBe(res.checkpointId);
    expect(cps[0].label).toContain('task=task-1');
    expect(cps[0].label).toContain('node=node-1');
    expect(cps[0].label).toContain('before writer run');
  });

  it('a throwing run rolls the workspace back and drops the checkpoint', async () => {
    const res = await runTransactional(
      { cwd: repo, taskId: 'task-1', nodeId: 'node-1', label: 'before writer run' },
      async () => {
        writeFileSync(path.join(repo, 'dirty.txt'), 'partial work\n');
        writeFileSync(path.join(repo, 'seed.txt'), 'MUTATED\n');
        throw new Error('writer gave up');
      },
    );
    expect(res.outcome).toBe('rolledback');
    expect(res.error).toContain('writer gave up');
    expect(res.error).toContain(`rolled back to checkpoint ${res.checkpointId}`);
    expect(res.checkpointId).toMatch(/^[0-9a-f]{8}$/);
    // Created-after-snapshot file removed, modified file reverted.
    expect(existsSync(path.join(repo, 'dirty.txt'))).toBe(false);
    expect(readFileSync(path.join(repo, 'seed.txt'), 'utf8')).toBe('original\n');
    // The spent recovery point is dropped.
    expect(await listCheckpoints(repo)).toHaveLength(0);
  });

  it('passthrough outside a git repo, with an honest note', async () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'tx-plain-'));
    try {
      const res = await runTransactional(
        { cwd: plain, label: 'before writer run' },
        async () => 'did work anyway',
      );
      expect(res.outcome).toBe('passthrough');
      expect(res.value).toBe('did work anyway');
      expect(res.note).toMatch(/not a git repository/);
      expect(res.checkpointId).toBeUndefined();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('passthrough when checkpoint creation fails, with the reason in the note', async () => {
    const { createCheckpoint } = await import('../checkpoint/checkpointManager.js');
    vi.mocked(createCheckpoint).mockResolvedValueOnce({
      ok: false,
      error: 'disk full',
    });
    const res = await runTransactional({ cwd: repo, label: 'cp' }, async () => 'ran anyway');
    expect(res.outcome).toBe('passthrough');
    expect(res.value).toBe('ran anyway');
    expect(res.note).toContain('disk full');
    vi.mocked(createCheckpoint).mockRestore();
  });

  it('a failed restore is surfaced, not swallowed', async () => {
    const res = await runTransactional(
      { cwd: repo, taskId: 'task-1', nodeId: 'node-1', label: 'cp' },
      async () => {
        // Sabotage the recovery point mid-run so the restore cannot resolve it.
        const cps = await listCheckpoints(repo);
        await dropCheckpoint(repo, cps[0].id);
        writeFileSync(path.join(repo, 'dirty.txt'), 'partial work\n');
        throw new Error('writer gave up');
      },
    );
    expect(res.outcome).toBe('rolledback');
    expect(res.error).toContain('writer gave up');
    expect(res.error).toMatch(/RESTORE FAILED/);
    expect(res.error).toMatch(/workspace may be dirty/);
    // Honest: the partial work is still there because the restore failed.
    expect(existsSync(path.join(repo, 'dirty.txt'))).toBe(true);
  });

  it('correlatedLabel embeds only what is provided', () => {
    expect(correlatedLabel({ cwd: 'x', label: 'L' })).toBe('L');
    expect(correlatedLabel({ cwd: 'x', taskId: 't', label: 'L' })).toBe('task=t · L');
    expect(correlatedLabel({ cwd: 'x', nodeId: 'n', label: 'L' })).toBe('node=n · L');
    expect(correlatedLabel({ cwd: 'x', taskId: 't', nodeId: 'n', label: 'L' })).toBe(
      'task=t node=n · L',
    );
  });
});
