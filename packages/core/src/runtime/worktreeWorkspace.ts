/**
 * runtime/worktreeWorkspace.ts — git worktree as a WorkspaceProvider.
 *
 * Generalizes the CLI krakenWorktree logic (ZELARI_KRAKEN_WORKTREE) into a
 * seam: two parallel writers on distinct worktrees cannot see each other's
 * files. Branches are named `zelari/worktree-<id>` under
 * `<sourceRoot>/.zelari/worktrees/<id>` (gitignored territory).
 */

import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { WorkspacePathEscapeError, type WorkspaceProvider } from './providers.js';

export interface WorktreeOptions {
  id?: string;
  /** Keep the worktree + branch on dispose (manual merge). */
  keepOnDispose?: boolean;
  /** Base ref/branch for the worktree (default: HEAD). */
  baseRef?: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf-8')));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf-8')));
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`));
    });
  });
}

export class WorktreeWorkspace implements WorkspaceProvider {
  readonly kind = 'worktree' as const;

  private disposed = false;

  private constructor(
    readonly root: string,
    readonly branch: string,
    private readonly sourceRoot: string,
    private readonly keep: boolean,
  ) {}

  /** Create an isolated worktree of `sourceRoot`. */
  static async create(sourceRoot: string, options: WorktreeOptions = {}): Promise<WorktreeWorkspace> {
    const id = options.id ?? crypto.randomUUID().slice(0, 8);
    const root = path.join(sourceRoot, '.zelari', 'worktrees', id);
    const branch = `zelari/worktree-${id}`;
    await git(sourceRoot, ['worktree', 'add', '-b', branch, root, options.baseRef ?? 'HEAD']);
    return new WorktreeWorkspace(root, branch, sourceRoot, options.keepOnDispose ?? false);
  }

  resolve(rel: string): string {
    const absolute = path.resolve(this.root, rel);
    const root = path.resolve(this.root);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      throw new WorkspacePathEscapeError(root, rel);
    }
    return absolute;
  }

  /** Files changed in this worktree vs the base (git status --porcelain). */
  async status(): Promise<string[]> {
    const out = await git(this.root, ['status', '--porcelain']);
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.slice(3).trim());
  }

  /**
   * Squash-merge this branch into the currently checked-out branch of the
   * source repo. Caller must be on the intended target branch.
   */
  async mergeSquashBack(): Promise<void> {
    await git(this.sourceRoot, ['merge', '--squash', this.branch]);
  }

  /** Remove the worktree (and its branch unless keep). Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await git(this.sourceRoot, ['worktree', 'remove', '--force', this.root]).catch(() => undefined);
    if (!this.keep) {
      await git(this.sourceRoot, ['branch', '-D', this.branch]).catch(() => undefined);
    }
  }
}
