import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  getWorkingDiff,
  undoWorkingChanges,
  isGitRepo,
  defaultProjectRoot,
} from '../../src/cli/gitOps.js';
import { handleSlashCommand } from '../../src/cli/slashCommands.js';

const execFileAsync = promisify(execFile);

/** Run a git command in the given cwd. Throws on non-zero exit. */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args]);
  return stdout;
}

describe('Task A4 — gitOps + /diff + /undo', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = path.join(
      os.tmpdir(),
      `anathema-gitops-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    await fs.mkdir(repoDir, { recursive: true });
    await git(repoDir, ['init', '-q']);
    await git(repoDir, ['config', 'user.email', 'test@example.com']);
    await git(repoDir, ['config', 'user.name', 'Test User']);
    // Seed an initial commit so HEAD exists.
    await fs.writeFile(path.join(repoDir, 'README.md'), '# test\n', 'utf-8');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-q', '-m', 'initial']);
  });

  afterEach(async () => {
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  describe('gitOps core helpers', () => {
    it('isGitRepo() returns true inside a git work tree', async () => {
      expect(await isGitRepo(repoDir)).toBe(true);
    });

    it('isGitRepo() returns false outside a git work tree', async () => {
      const nonRepo = path.join(os.tmpdir(), `non-repo-${Date.now()}`);
      await fs.mkdir(nonRepo, { recursive: true });
      try {
        expect(await isGitRepo(nonRepo)).toBe(false);
      } finally {
        await fs.rm(nonRepo, { recursive: true, force: true });
      }
    });

    it('getWorkingDiff() returns empty when working tree is clean', async () => {
      const r = await getWorkingDiff({ cwd: repoDir });
      expect(r.empty).toBe(true);
      expect(r.diff).toBe('');
      expect(r.truncated).toBe(false);
    });

    it('getWorkingDiff() detects unstaged modifications', async () => {
      await fs.writeFile(path.join(repoDir, 'README.md'), '# test changed\n', 'utf-8');
      const r = await getWorkingDiff({ cwd: repoDir });
      expect(r.empty).toBe(false);
      expect(r.diff).toContain('README.md');
      expect(r.diff).toContain('-# test');
      expect(r.diff).toContain('+# test changed');
    });

    it('getWorkingDiff() omits staged changes by default', async () => {
      await fs.writeFile(path.join(repoDir, 'README.md'), '# staged edit\n', 'utf-8');
      await git(repoDir, ['add', '.']);
      const r = await getWorkingDiff({ cwd: repoDir });
      expect(r.empty).toBe(true);
    });

    it('getWorkingDiff({ staged: true }) includes staged changes', async () => {
      await fs.writeFile(path.join(repoDir, 'README.md'), '# staged edit\n', 'utf-8');
      await git(repoDir, ['add', '.']);
      const r = await getWorkingDiff({ cwd: repoDir, staged: true });
      expect(r.empty).toBe(false);
      expect(r.diff).toContain('README.md');
    });

    it('getWorkingDiff() truncates output past maxChars', async () => {
      // Add a tracked file first, then modify it.
      const baseline = Array.from({ length: 100 }, () => 'baseline line');
      await fs.writeFile(path.join(repoDir, 'big.txt'), baseline.join('\n') + '\n', 'utf-8');
      await git(repoDir, ['add', '.']);
      await git(repoDir, ['commit', '-q', '-m', 'add big.txt']);
      // Now replace it with a much larger tracked file.
      const lines = Array.from({ length: 5000 }, () => 'lorem ipsum dolor sit amet');
      await fs.writeFile(path.join(repoDir, 'big.txt'), lines.join('\n') + '\n', 'utf-8');
      const r = await getWorkingDiff({ cwd: repoDir, maxChars: 500 });
      expect(r.empty).toBe(false);
      expect(r.truncated).toBe(true);
      expect(r.diff.length).toBe(500);
    });

    it('undoWorkingChanges() reverts unstaged modifications', async () => {
      await fs.writeFile(path.join(repoDir, 'README.md'), '# dirty\n', 'utf-8');
      // Verify the change is visible.
      const before = await getWorkingDiff({ cwd: repoDir });
      expect(before.empty).toBe(false);

      const res = await undoWorkingChanges({ cwd: repoDir });
      expect(res.reverted.length).toBeGreaterThan(0);
      expect(res.summary).toMatch(/reverted/i);

      // Working tree should be clean now.
      const after = await getWorkingDiff({ cwd: repoDir });
      expect(after.empty).toBe(true);
      // File content should match the committed version.
      const content = await fs.readFile(path.join(repoDir, 'README.md'), 'utf-8');
      expect(content).toBe('# test\n');
    });

    it('undoWorkingChanges({ unstage: false }) keeps staged changes in INDEX', async () => {
      // With unstage:false, we still run `git checkout -- .` — but the
      // checkout restores from the INDEX for staged paths. So a staged
      // file stays at its staged content (not HEAD content).
      await fs.writeFile(path.join(repoDir, 'README.md'), '# staged edit\n', 'utf-8');
      await git(repoDir, ['add', '.']);
      await undoWorkingChanges({ cwd: repoDir, unstage: false });
      const content = await fs.readFile(path.join(repoDir, 'README.md'), 'utf-8');
      expect(content).toBe('# staged edit\n');
    });

    it('undoWorkingChanges() does NOT touch untracked files', async () => {
      await fs.writeFile(path.join(repoDir, 'untracked.txt'), 'keep me\n', 'utf-8');
      const res = await undoWorkingChanges({ cwd: repoDir });
      // Untracked files shouldn't appear in reverted list.
      expect(res.reverted).not.toContain('untracked.txt');
      const stillThere = await fs.readFile(path.join(repoDir, 'untracked.txt'), 'utf-8');
      expect(stillThere).toBe('keep me\n');
    });

    it('defaultProjectRoot() returns a directory that exists', async () => {
      const root = defaultProjectRoot();
      const stat = await fs.stat(root);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('slash command /diff', () => {
    it('/diff → kind=diff, diffStaged=undefined', () => {
      const r = handleSlashCommand('/diff', []);
      expect(r.handled).toBe(true);
      expect(r.kind).toBe('diff');
      expect(r.diffStaged).toBeUndefined();
    });

    it('/diff --staged → kind=diff, diffStaged=true', () => {
      const r = handleSlashCommand('/diff --staged', []);
      expect(r.handled).toBe(true);
      expect(r.kind).toBe('diff');
      expect(r.diffStaged).toBe(true);
    });

    it('/diff --cached → kind=diff, diffStaged=true', () => {
      const r = handleSlashCommand('/diff --cached', []);
      expect(r.handled).toBe(true);
      expect(r.kind).toBe('diff');
      expect(r.diffStaged).toBe(true);
    });
  });

  describe('slash command /undo', () => {
    it('/undo without confirmation → kind=undo + warning message', () => {
      const r = handleSlashCommand('/undo', []);
      expect(r.handled).toBe(true);
      expect(r.kind).toBe('undo');
      expect(r.undoConfirmed).toBeUndefined();
      expect(r.message).toMatch(/destructive/i);
      expect(r.message).toMatch(/--yes/);
    });

    it('/undo --yes → kind=undo_confirm, undoConfirmed=true', () => {
      const r = handleSlashCommand('/undo --yes', []);
      expect(r.handled).toBe(true);
      expect(r.kind).toBe('undo_confirm');
      expect(r.undoConfirmed).toBe(true);
    });

    it('/undo -y → kind=undo_confirm, undoConfirmed=true', () => {
      const r = handleSlashCommand('/undo -y', []);
      expect(r.handled).toBe(true);
      expect(r.kind).toBe('undo_confirm');
      expect(r.undoConfirmed).toBe(true);
    });
  });
});