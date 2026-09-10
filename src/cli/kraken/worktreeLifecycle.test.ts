/**
 * Int3c (plan v2 §7.3) — worktree lifecycle micro-opts — tests.
 *
 * Two behaviors are pinned here, both against a REAL git repo (no stubbed
 * git): the `rev-parse --show-toplevel` memo, and the end-of-run cleanup
 * batch. Spawn counts come from a counting wrapper around
 * `child_process.execFile` — the module under test promisifies it, so the
 * wrapper is the honest observation point for "how many git processes did
 * this actually cost".
 *
 * The batch assertions are deliberately asymmetric: the queue is inspected in
 * git's own state (branch still present / gone), so a test can not pass just
 * because the implementation returned a nice summary.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KrakenGraphExecutor } from './executor.js';
import { buildGraphFromPlan } from './planner.js';
import {
  __resetKrakenWorktreeCleanupQueueForTests,
  queueWorktreeCleanup,
  takeQueuedWorktreeCleanup,
} from './worktreeCleanupBatch.js';
import {
  __resetKrakenWorktreeLifecycleForTests,
  beginKrakenWorktreeCleanupBatch,
  cleanupKrakenWorktree,
  createKrakenWorktree,
  flushKrakenWorktreeCleanupBatch,
  isKrakenWorktreeCleanupBatched,
  resolveGitRoot,
  resolveWorktreeCleanupMode,
  type WorktreeHandle,
} from '../tools/krakenWorktree.js';
import type { TentacleResult } from '../tools/taskTool.js';

/** Every `execFile('git', [...])` issued by the module under test. */
const gitSpawns = vi.hoisted(() => [] as string[][]);

/**
 * `child_process.execFile` is wrapped, not replaced: the module under test
 * calls `promisify(execFile)`, and Node's `execFile` carries a
 * `util.promisify.custom` implementation that resolves `{stdout, stderr}` —
 * so the wrapper forwards BOTH the callback form and that custom form,
 * recording the argv either way. (`importOriginal` gives the real module.)
 */
vi.mock('node:child_process', async (importOriginal) => {
  const { promisify } = await import('node:util');
  const actual = await importOriginal<typeof import('node:child_process')>();
  const realPromisified = (
    actual.execFile as unknown as Record<symbol, (...a: unknown[]) => unknown>
  )[promisify.custom];

  const execFile = ((file: string, args: string[], third?: unknown, fourth?: unknown) => {
    gitSpawns.push([file, ...(args ?? [])]);
    const cb = typeof third === 'function' ? third : fourth;
    const opts = typeof third === 'function' ? undefined : third;
    return (actual.execFile as unknown as (...a: unknown[]) => unknown)(file, args, opts, cb);
  }) as unknown as typeof actual.execFile;

  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
    file: string,
    args: string[],
    opts: unknown,
  ) => {
    gitSpawns.push([file, ...(args ?? [])]);
    return realPromisified(file, args, opts);
  };

  return { ...actual, execFile };
});

/** The git subcommand of a recorded spawn (`git -C <cwd> <cmd> …`). */
function commandTail(argv: string[]): string[] {
  return argv[0] === 'git' && argv[1] === '-C' ? argv.slice(3) : argv.slice(1);
}

function countCommand(...needle: string[]): number {
  return gitSpawns.filter((argv) => {
    const tail = commandTail(argv);
    return needle.every((n, i) => tail[i] === n);
  }).length;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** `kraken/*` branches currently present in the repo. */
function krakenBranches(repo: string): string[] {
  return git(repo, 'branch', '--list', 'kraken/*')
    .split('\n')
    .map((l) => l.replace(/^[*+]\s*/, '').trim())
    .filter(Boolean);
}

/** Env without any of the worktree flags: the documented defaults apply. */
const CLEAN_ENV: NodeJS.ProcessEnv = {};

function okResult(description: string): TentacleResult {
  return {
    ok: true,
    agent: 'explore',
    thoroughness: 'medium',
    model: 'mock-model',
    result: `done: ${description}`,
    footer: '',
    worktreePath: null,
    worktreeHandle: null,
  };
}

describe('Int3c — worktree lifecycle', () => {
  let repo: string;
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'kraken-wt3c-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'kraken@zelari.local');
    git(repo, 'config', 'user.name', 'Kraken Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(repo, 'base.txt'), 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');

    for (const k of [
      'ZELARI_KRAKEN_WORKTREE_CLEANUP',
      'ZELARI_KRAKEN_WORKTREE_KEEP',
      'ZELARI_KRAKEN_WORKTREE',
    ]) {
      envBackup[k] = process.env[k];
      delete process.env[k];
    }
    __resetKrakenWorktreeLifecycleForTests();
    gitSpawns.length = 0;
  });

  afterEach(() => {
    __resetKrakenWorktreeLifecycleForTests();
    rmSync(repo, { recursive: true, force: true });
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('defaults the cleanup mode to batch and only `eager` opts out', () => {
    expect(resolveWorktreeCleanupMode(CLEAN_ENV)).toBe('batch');
    expect(resolveWorktreeCleanupMode({ ZELARI_KRAKEN_WORKTREE_CLEANUP: 'EAGER' })).toBe('eager');
    // A typo must not silently resurrect the per-worktree subprocesses.
    expect(resolveWorktreeCleanupMode({ ZELARI_KRAKEN_WORKTREE_CLEANUP: 'batched' })).toBe('batch');
  });

  it('memoizes the repo toplevel for the process', async () => {
    const first = await resolveGitRoot(repo);
    expect(first).toBeTruthy();
    // Take the repo away: a fresh probe would now fail, so a second answer
    // proves the first one was served from the memo, not re-observed.
    rmSync(path.join(repo, '.git'), { recursive: true, force: true });
    expect(await resolveGitRoot(repo)).toBe(first);
    // ... and the reset hook proves the probe would indeed have failed.
    __resetKrakenWorktreeLifecycleForTests();
    expect(await resolveGitRoot(repo)).toBeNull();
  });

  it('spawns one `rev-parse --show-toplevel` for two resolutions', async () => {
    gitSpawns.length = 0;
    await resolveGitRoot(repo);
    await resolveGitRoot(path.join(repo, '.'));
    expect(countCommand('rev-parse', '--show-toplevel')).toBe(1);
  });

  it('batch mode defers two cleanups into ONE prune + ONE branch -D at flush', async () => {
    const a = (await createKrakenWorktree(repo, 'alpha')) as WorktreeHandle;
    const b = (await createKrakenWorktree(repo, 'beta')) as WorktreeHandle;
    expect(a && b).toBeTruthy();
    expect(krakenBranches(repo).length).toBe(2);

    expect(beginKrakenWorktreeCleanupBatch(CLEAN_ENV)).toBe(true);
    gitSpawns.length = 0;

    await cleanupKrakenWorktree(a, CLEAN_ENV);
    await cleanupKrakenWorktree(b, CLEAN_ENV);

    // Eager part: the filesystem is free immediately, per worktree.
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(b.path)).toBe(false);
    expect(countCommand('worktree', 'remove', '--force')).toBe(2);
    // Deferred part: no repo-level bookkeeping yet, and the branches are
    // genuinely still there (not just unreported).
    expect(countCommand('worktree', 'prune')).toBe(0);
    expect(countCommand('branch', '-D')).toBe(0);
    expect(krakenBranches(repo).length).toBe(2);

    gitSpawns.length = 0;
    const flushed = await flushKrakenWorktreeCleanupBatch();
    expect(flushed.pruned).toBe(1);
    expect(flushed.branches.length).toBe(2);
    expect(flushed.deleted.length).toBe(2);
    expect(countCommand('worktree', 'prune')).toBe(1);
    expect(countCommand('branch', '-D')).toBe(1);
    expect(krakenBranches(repo)).toEqual([]);
    // Flushing twice must not issue a second pair of commands.
    gitSpawns.length = 0;
    expect((await flushKrakenWorktreeCleanupBatch()).pruned).toBe(0);
    expect(countCommand('worktree', 'prune')).toBe(0);
    expect(countCommand('branch', '-D')).toBe(0);
  });

  it('ZELARI_KRAKEN_WORKTREE_CLEANUP=eager keeps the per-worktree cleanup', async () => {
    const eagerEnv: NodeJS.ProcessEnv = { ZELARI_KRAKEN_WORKTREE_CLEANUP: 'eager' };
    expect(beginKrakenWorktreeCleanupBatch(eagerEnv)).toBe(false);

    const a = (await createKrakenWorktree(repo, 'alpha')) as WorktreeHandle;
    const b = (await createKrakenWorktree(repo, 'beta')) as WorktreeHandle;
    gitSpawns.length = 0;

    await cleanupKrakenWorktree(a, eagerEnv);
    // Today's behavior: branch gone right after its own worktree.
    expect(krakenBranches(repo).length).toBe(1);
    await cleanupKrakenWorktree(b, eagerEnv);
    expect(krakenBranches(repo)).toEqual([]);
    expect(countCommand('worktree', 'prune')).toBe(2);
    expect(countCommand('branch', '-D')).toBe(2);

    gitSpawns.length = 0;
    expect((await flushKrakenWorktreeCleanupBatch()).pruned).toBe(0);
    expect(countCommand('worktree', 'prune')).toBe(0);
  });

  it('cleans up eagerly outside a run scope (nothing would flush the queue)', async () => {
    const handle = (await createKrakenWorktree(repo, 'lone')) as WorktreeHandle;
    gitSpawns.length = 0;
    await cleanupKrakenWorktree(handle, CLEAN_ENV);
    expect(krakenBranches(repo)).toEqual([]);
    expect(countCommand('worktree', 'prune')).toBe(1);
    expect(countCommand('branch', '-D')).toBe(1);
  });

  it('the graph executor opens the batch and flushes it at the end of the run', async () => {
    const graph = buildGraphFromPlan('kraken-wt3c', [
      { id: 'e1', kind: 'explore', label: 'simulate a writer', prompt: 'simulate', deps: [] },
    ]);

    let branchDuringRun: string[] = [];
    let handle: WorktreeHandle | null = null;

    const executor = new KrakenGraphExecutor({
      taskToolDeps: { createSubAgentContext: async () => null },
      parentCwd: repo,
      sessionId: 'sess-wt3c',
      goal: 'worktree lifecycle',
      runTentacleFn: async (opts) => {
        // Stand in for a writer that finished: create then clean up a
        // worktree, exactly as the tentacle path does.
        handle = await createKrakenWorktree(repo, opts.args.description);
        if (handle) await cleanupKrakenWorktree(handle);
        branchDuringRun = krakenBranches(repo);
        return okResult(opts.args.description);
      },
      mergeFn: async () => ({
        ok: true,
        merged: false,
        committed: false,
        conflict: false,
        message: 'no-op',
      }),
    });

    const summary = await executor.execute(graph);
    expect(summary.converged).toBe(true);
    expect(handle).toBeTruthy();
    // Inside the run the cleanup was deferred (the executor's scope is open)…
    expect(branchDuringRun.length).toBe(1);
    // …and the end-of-run flush drained it.
    expect(krakenBranches(repo)).toEqual([]);
  });

  it('the queue dedups per repo root and closes one scope per drain', () => {
    __resetKrakenWorktreeCleanupQueueForTests();
    expect(isKrakenWorktreeCleanupBatched(CLEAN_ENV)).toBe(false);

    // Two scopes open (a run and, say, a nested one): one drain each.
    expect(beginKrakenWorktreeCleanupBatch(CLEAN_ENV)).toBe(true);
    expect(beginKrakenWorktreeCleanupBatch(CLEAN_ENV)).toBe(true);
    expect(isKrakenWorktreeCleanupBatched(CLEAN_ENV)).toBe(true);

    queueWorktreeCleanup('/repo', 'kraken/a');
    queueWorktreeCleanup('/repo', 'kraken/b');
    queueWorktreeCleanup('/repo', 'kraken/a'); // duplicate branch
    queueWorktreeCleanup('/repo', null); // worktree without a named branch
    queueWorktreeCleanup('/other', null);

    const first = takeQueuedWorktreeCleanup();
    expect(new Set(first.repoRoots)).toEqual(new Set(['/repo', '/other']));
    expect(first.branchesByRoot.get('/repo')?.sort()).toEqual(['kraken/a', 'kraken/b']);
    // The drain closed only one scope; the nested one is still open.
    expect(isKrakenWorktreeCleanupBatched(CLEAN_ENV)).toBe(true);

    const second = takeQueuedWorktreeCleanup();
    expect(second.repoRoots).toEqual([]);
    expect(isKrakenWorktreeCleanupBatched(CLEAN_ENV)).toBe(false);

    // `eager` never opens a scope, so nothing can be queued behind the
    // caller's back and left there.
    expect(beginKrakenWorktreeCleanupBatch({ ZELARI_KRAKEN_WORKTREE_CLEANUP: 'eager' })).toBe(
      false,
    );
    expect(isKrakenWorktreeCleanupBatched(CLEAN_ENV)).toBe(false);
  });
});
