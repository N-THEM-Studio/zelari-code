/**
 * WS3 (2.39) — worktree isolation is DEFAULT ON for general tentacles.
 *
 * The acceptance contract of this slice, in the order it is pinned here:
 *
 *   1. **Flip** — with no env at all, a `general` writer runs in
 *      `<repo>/.zelari/worktrees/kraken-*`; `ZELARI_KRAKEN_WORKTREE=0` is the
 *      explicit opt-out that restores execution in the parent tree.
 *   2. **Dirty parent stays untouched** — the whole point of isolation: a
 *      tentacle write must not appear in the parent tree, and a pre-existing
 *      dirty file in the parent must survive byte-for-byte.
 *   3. **Honest degradation** — a non-git folder (or a failed `worktree add`)
 *      keeps the tentacle running in the shared tree, and the reason is
 *      recorded on the radio + reported through `deps.onWorktreeFallback`,
 *      never swallowed.
 *   4. **Teardown** — `KEEP=1` retains worktree+branch (and disables the merge),
 *      the retry/guard helpers degrade instead of deleting something that is
 *      not a kraken worktree, and the branch is only removed once the
 *      directory is actually gone.
 *
 * Real git fixtures (init + worktree + squash-merge), like
 * `kraken/krakenWorktree.rollback.test.ts` — a stubbed git could not observe
 * parent-tree state, which is exactly what is asserted here. Explicit timeout
 * budget for the same reason: git-heavy tests do not fit the 5s default under
 * a full-suite parallel run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrainEvent } from '@zelari/core/shared/events';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';
import {
  __resetKrakenWorktreeLifecycleForTests,
  beginKrakenWorktreeCleanupBatch,
  cleanupKrakenWorktree,
  createKrakenWorktree,
  isInsideKrakenWorktrees,
  isKrakenWorktreeAutoMergeEnabled,
  isKrakenWorktreeEnabled,
  isKrakenWorktreeIsolationEnabled,
  isLongPath,
  isRetryableCleanupError,
  removePathWithRetry,
  resolveKrakenWorktreeMode,
  shouldKeepWorktree,
  toLongPath,
  type WorktreeHandle,
} from './krakenWorktree.js';
import { readKrakenRadio } from './krakenRadio.js';
import {
  createTaskTool,
  runTentacle,
  type SubAgentContext,
  type SubAgentHarness,
  type TaskToolDeps,
  type WorktreeFallbackInfo,
} from './taskTool.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const WT_ENV_KEYS = [
  'ZELARI_KRAKEN_WORKTREE',
  'ZELARI_KRAKEN_WORKTREE_KEEP',
  'ZELARI_KRAKEN_WORKTREE_AUTO_MERGE',
  'ZELARI_KRAKEN_WORKTREE_CLEANUP',
] as const;

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

function krakenBranches(repo: string): string[] {
  return git(repo, 'branch', '--list', 'kraken/*')
    .split('\n')
    .map((l) => l.replace(/^[*+]\s*/, '').trim())
    .filter(Boolean);
}

const dummyContext: SubAgentContext = {
  providerStream: (async function* () {})() as never,
  model: 'm',
  provider: 'openai-compatible',
  registry: {} as never,
  tools: [],
};

function fakeHarness(events: Array<Partial<BrainEvent>>): SubAgentHarness {
  return {
    async *run() {
      for (const e of events) yield e as BrainEvent;
    },
  };
}

const DONE_EVENTS: Array<Partial<BrainEvent>> = [
  { type: 'message_start' },
  { type: 'message_delta', delta: 'wrote the file' } as Partial<BrainEvent>,
  { type: 'message_end' },
];

/* ------------------------------------------------------------------ */
/* 1. The flip itself — pure, no git, no spawn                          */
/* ------------------------------------------------------------------ */

describe('WS3 resolveKrakenWorktreeMode — isolation defaults ON', () => {
  it('is ON with no env at all, and stays ON for every legacy truthy spelling', () => {
    expect(resolveKrakenWorktreeMode({})).toBe('on');
    expect(resolveKrakenWorktreeMode({ ZELARI_KRAKEN_WORKTREE: '' })).toBe('on');
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE', ' 1 ']) {
      expect(resolveKrakenWorktreeMode({ ZELARI_KRAKEN_WORKTREE: v })).toBe('on');
    }
    // Fail-closed on an unrecognized value: isolation is what protects the
    // user's tree, so a typo must not silently drop it.
    expect(resolveKrakenWorktreeMode({ ZELARI_KRAKEN_WORKTREE: 'maybe' })).toBe('on');
  });

  it('is OFF only for the explicit opt-out tokens', () => {
    for (const v of ['0', 'false', 'no', 'off', 'OFF', ' disabled ']) {
      expect(resolveKrakenWorktreeMode({ ZELARI_KRAKEN_WORKTREE: v })).toBe('off');
    }
  });

  it('keeps `auto` distinct (isolation + scheduler rescue)', () => {
    expect(resolveKrakenWorktreeMode({ ZELARI_KRAKEN_WORKTREE: 'auto' })).toBe('auto');
  });

  it('isKrakenWorktreeIsolationEnabled follows the mode, not the raw token', () => {
    expect(isKrakenWorktreeIsolationEnabled({})).toBe(true);
    expect(isKrakenWorktreeIsolationEnabled({ ZELARI_KRAKEN_WORKTREE: 'auto' })).toBe(true);
    expect(isKrakenWorktreeIsolationEnabled({ ZELARI_KRAKEN_WORKTREE: '0' })).toBe(false);
  });

  it('the legacy truthy predicate keeps its old contract (nothing new depends on it)', () => {
    expect(isKrakenWorktreeEnabled({})).toBe(false);
    expect(isKrakenWorktreeEnabled({ ZELARI_KRAKEN_WORKTREE: '1' })).toBe(true);
  });

  it('KEEP=1 is "no merge AND no cleanup" — verified against the code, documented here', () => {
    expect(shouldKeepWorktree({})).toBe(false);
    expect(shouldKeepWorktree({ ZELARI_KRAKEN_WORKTREE_KEEP: '1' })).toBe(true);
    // KEEP wins over the auto-merge default: keeping the worktree exists
    // precisely so the user merges it by hand.
    expect(isKrakenWorktreeAutoMergeEnabled({})).toBe(true);
    expect(
      isKrakenWorktreeAutoMergeEnabled({
        ZELARI_KRAKEN_WORKTREE_KEEP: '1',
        ZELARI_KRAKEN_WORKTREE_AUTO_MERGE: '1',
      }),
    ).toBe(false);
    expect(isKrakenWorktreeAutoMergeEnabled({ ZELARI_KRAKEN_WORKTREE_AUTO_MERGE: '0' })).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 2. win32 hardening helpers                                          */
/* ------------------------------------------------------------------ */

describe('WS3 win32 hardening helpers', () => {
  it('toLongPath switches to the extended-length form on win32 only', () => {
    expect(toLongPath('C:\\a\\b', 'win32')).toBe('\\\\?\\C:\\a\\b');
    expect(toLongPath('\\\\?\\C:\\a\\b', 'win32')).toBe('\\\\?\\C:\\a\\b');
    expect(toLongPath('\\\\server\\share\\x', 'win32')).toBe('\\\\?\\UNC\\server\\share\\x');
    expect(toLongPath('/home/u/x', 'linux')).toBe('/home/u/x');
  });

  it('isLongPath only fires past the MAX_PATH budget', () => {
    expect(isLongPath('C:\\short\\path')).toBe(false);
    expect(isLongPath(`C:\\${'a'.repeat(260)}`)).toBe(true);
  });

  it('isInsideKrakenWorktrees refuses anything that is not a kraken worktree', () => {
    const repo = path.resolve('C:\\repo');
    const root = path.join(repo, '.zelari', 'worktrees');
    expect(isInsideKrakenWorktrees(path.join(root, 'kraken-abc'), repo)).toBe(true);
    // The root itself, a non-kraken child, and any user path above it.
    expect(isInsideKrakenWorktrees(root, repo)).toBe(false);
    expect(isInsideKrakenWorktrees(path.join(root, 'not-a-worktree'), repo)).toBe(false);
    expect(isInsideKrakenWorktrees(path.join(repo, 'src'), repo)).toBe(false);
    expect(isInsideKrakenWorktrees(repo, repo)).toBe(false);
  });

  it('isRetryableCleanupError covers lock/permission failures only', () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']) {
      expect(isRetryableCleanupError({ code })).toBe(true);
    }
    expect(isRetryableCleanupError({ code: 'ENOENT' })).toBe(false);
    expect(isRetryableCleanupError(new Error('plain'))).toBe(false);
  });

  it('removePathWithRetry retries transient failures and reports how many tries it spent', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zelari-wt-retry-'));
    const waits: number[] = [];
    let calls = 0;
    const outcome = await removePathWithRetry(dir, {
      remove: () => {
        calls += 1;
        throw Object.assign(new Error('locked by another handle'), { code: 'EBUSY' });
      },
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    expect(calls).toBe(3); // bounded: 3 attempts, not an endless loop
    expect(outcome.attempts).toBe(3);
    expect(outcome.removed).toBe(false);
    expect(outcome.lastError).toContain('EBUSY');
    expect(waits.length).toBe(2);
    expect(waits[0]).toBeLessThan(100); // short backoff, not a stall
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('removePathWithRetry succeeds once the lock clears (attempt 3)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zelari-wt-recover-'));
    let calls = 0;
    const outcome = await removePathWithRetry(dir, {
      remove: () => {
        calls += 1;
        if (calls === 3) rmSync(dir, { recursive: true, force: true });
      },
      sleep: async () => {},
    });

    expect(calls).toBe(3);
    expect(outcome.attempts).toBe(3);
    expect(outcome.removed).toBe(true);
    expect(outcome.lastError).toBeNull();
    expect(existsSync(dir)).toBe(false);
  });

  it('removePathWithRetry treats ENOENT as success and a non-transient error as terminal', async () => {
    const gone = await removePathWithRetry('C:\\whatever\\gone', {
      remove: () => {
        throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      },
      sleep: async () => {},
    });
    expect(gone.removed).toBe(true);
    expect(gone.attempts).toBe(1);

    // A genuine error (not a lock) is not retried: one attempt, then report.
    const dir = mkdtempSync(path.join(tmpdir(), 'zelari-wt-hard-'));
    let attempts = 0;
    const hard = await removePathWithRetry(dir, {
      remove: () => {
        attempts += 1;
        throw Object.assign(new Error('bad path'), { code: 'EINVAL' });
      },
      sleep: async () => {},
    });
    expect(attempts).toBe(1);
    expect(hard.removed).toBe(false);
    expect(hard.lastError).toContain('EINVAL');
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('removePathWithRetry deletes a real directory (default rm path)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zelari-wt-sweep-'));
    writeFileSync(path.join(dir, 'inner.txt'), 'x\n');
    const outcome = await removePathWithRetry(dir);
    expect(outcome.removed).toBe(true);
    expect(outcome.attempts).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 3. End-to-end: default ON, dirty parent tree, opt-out                */
/* ------------------------------------------------------------------ */

describe('WS3 taskTool — default isolation with a REAL git fixture', () => {
  let root: string;
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'kraken-ws3-'));
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'kraken@zelari.local');
    git(root, 'config', 'user.name', 'Kraken Test');
    git(root, 'config', 'commit.gpgsign', 'false');
    // `.zelari/` is gitignored in the real repo too — the worktrees root lives
    // there and must never show up as an untracked change of the parent.
    writeFileSync(path.join(root, '.gitignore'), '.zelari/\n');
    writeFileSync(path.join(root, 'tracked.txt'), 'original\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
    // Dirty parent tree: one modified tracked file + one untracked file.
    writeFileSync(path.join(root, 'tracked.txt'), 'EDITED BY USER\n');
    writeFileSync(path.join(root, 'scratch.txt'), 'user scratch\n');

    for (const k of WT_ENV_KEYS) {
      envBackup[k] = process.env[k];
      delete process.env[k];
    }
    __resetKrakenWorktreeLifecycleForTests();
  });

  afterEach(() => {
    __resetKrakenWorktreeLifecycleForTests();
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  interface Recorder {
    generalCwd: string | null;
    verifyCwd: string | null;
    /** Set from INSIDE the writer: did the file land where the tentacle ran? */
    wroteInWorktree: boolean;
  }

  function toolThatWrites(rec: Recorder, fileName: string) {
    return createTaskTool({
      createSubAgentContext: async ({ agent, cwd }) => {
        if (agent === 'general') {
          rec.generalCwd = cwd;
          writeFileSync(path.join(cwd, fileName), 'from tentacle\n');
          rec.wroteInWorktree = existsSync(path.join(cwd, fileName));
        } else {
          rec.verifyCwd = cwd;
        }
        return { ...dummyContext, cwd };
      },
      harnessFactory: () => fakeHarness(DONE_EVENTS),
    });
  }

  function newRecorder(): Recorder {
    return { generalCwd: null, verifyCwd: null, wroteInWorktree: false };
  }

  function ctx(sessionId: string): ToolContext {
    return { signal: new AbortController().signal, cwd: root, audit: () => {}, sessionId };
  }

  it('a general writer is isolated by DEFAULT and the dirty parent tree is untouched', async () => {
    process.env.ZELARI_KRAKEN_WORKTREE_AUTO_MERGE = '0'; // isolate only: no merge-back
    const before = porcelain(root);
    expect(before).toContain('tracked.txt');
    expect(before).toContain('scratch.txt');

    const rec = newRecorder();
    const tool = toolThatWrites(rec, 'tentacle-only.txt');
    const res = await tool.execute(
      { description: 'write one file', prompt: 'add tentacle-only.txt', agent: 'general' },
      ctx('ws3-default'),
    );

    expect(res.ok).toBe(true);
    // The writer really did run in a worktree under .zelari/worktrees/ …
    expect(rec.generalCwd).toBeTruthy();
    const wtCwd = rec.generalCwd as unknown as string;
    expect(wtCwd).toContain(path.join('.zelari', 'worktrees'));
    expect(wtCwd.startsWith(path.join(root, '.zelari', 'worktrees'))).toBe(true);
    // …and its write landed THERE (observed from inside the run), not in the parent.
    expect(rec.wroteInWorktree).toBe(true);
    expect(existsSync(path.join(root, 'tentacle-only.txt'))).toBe(false);

    // The parent tree is byte-for-byte what the user left behind: same
    // porcelain, same dirty content, same untracked scratch file.
    expect(porcelain(root)).toBe(before);
    expect(readFileSync(path.join(root, 'tracked.txt'), 'utf8')).toBe('EDITED BY USER\n');
    expect(readFileSync(path.join(root, 'scratch.txt'), 'utf8')).toBe('user scratch\n');

    if (res.ok) {
      expect(res.value.result).toMatch(/worktree used:/);
    }
    // The spawn event carries the isolation path (observability, not a guess).
    const spawns = readKrakenRadio(root, 'ws3-default', 100).filter((e) => e.kind === 'spawn');
    expect(spawns.some((e) => e.worktree === wtCwd)).toBe(true);
    // Cleanup is deterministic: the worktree directory is gone afterwards and
    // no kraken branch is left behind in the parent repo.
    expect(existsSync(wtCwd)).toBe(false);
    expect(krakenBranches(root)).toEqual([]);
  });

  it('with auto-merge (the default) the tentacle work reaches the parent AND the dirty file survives', async () => {
    const rec = newRecorder();
    const tool = toolThatWrites(rec, 'merged-from-worktree.txt');
    const res = await tool.execute(
      { description: 'write one file', prompt: 'add merged-from-worktree.txt', agent: 'general' },
      ctx('ws3-merge'),
    );

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.result).toMatch(/worktree merge \[ok\]/);
    expect(existsSync(path.join(root, 'merged-from-worktree.txt'))).toBe(true);
    // git's checkout normalization (autocrlf) owns the parent-side line
    // endings — what matters is the content that arrived.
    expect(
      readFileSync(path.join(root, 'merged-from-worktree.txt'), 'utf8').replace(/\r\n/g, '\n'),
    ).toBe('from tentacle\n');
    // A merge of an unrelated new file must not touch what was already dirty.
    expect(readFileSync(path.join(root, 'tracked.txt'), 'utf8')).toBe('EDITED BY USER\n');
    expect(porcelain(root)).toContain('M tracked.txt');
    expect(existsSync(path.join(root, 'scratch.txt'))).toBe(true);
  });

  it('ZELARI_KRAKEN_WORKTREE=0 is the explicit opt-out: the writer runs in the parent tree', async () => {
    process.env.ZELARI_KRAKEN_WORKTREE = '0';
    const rec = newRecorder();
    const tool = toolThatWrites(rec, 'in-parent.txt');
    const res = await tool.execute(
      { description: 'write one file', prompt: 'add in-parent.txt', agent: 'general' },
      ctx('ws3-optout'),
    );

    expect(res.ok).toBe(true);
    // No worktree at all: same cwd as the parent, no isolation directory.
    expect(rec.generalCwd).toBe(root);
    expect(existsSync(path.join(root, '.zelari', 'worktrees'))).toBe(false);
    expect(existsSync(path.join(root, 'in-parent.txt'))).toBe(true);
    if (res.ok) {
      expect(res.value.result).not.toMatch(/worktree used:/);
      expect(res.value.result).not.toMatch(/worktree merge/);
      expect(res.value.worktreePath ?? null).toBeNull();
      expect(res.value.worktreeHandle ?? null).toBeNull();
    }
    const radio = readKrakenRadio(root, 'ws3-optout', 100);
    expect(radio.some((e) => e.kind === 'worktree.fallback_shared_tree')).toBe(false);
    expect(radio.find((e) => e.kind === 'spawn')?.worktree ?? null).toBeNull();
    expect(readFileSync(path.join(root, 'tracked.txt'), 'utf8')).toBe('EDITED BY USER\n');
  });

  it('KEEP=1 retains worktree + branch and does not merge (documented semantics)', async () => {
    process.env.ZELARI_KRAKEN_WORKTREE_KEEP = '1';
    const rec = newRecorder();
    const tool = toolThatWrites(rec, 'kept.txt');
    const res = await tool.execute(
      { description: 'write one file', prompt: 'add kept.txt', agent: 'general' },
      ctx('ws3-keep'),
    );

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.result).toMatch(/worktree kept:/);
    const wtCwd = rec.generalCwd as unknown as string;
    expect(existsSync(path.join(wtCwd, 'kept.txt'))).toBe(true);
    expect(existsSync(path.join(root, 'kept.txt'))).toBe(false);
    expect(krakenBranches(root).length).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Honest degradation                                               */
/* ------------------------------------------------------------------ */

describe('WS3 honest degradation — no git, no worktree, no silence', () => {
  let dir: string;
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'kraken-ws3-nogit-'));
    // The global vitest setup pins ZELARI_KRAKEN_WORKTREE=0 (see
    // tests/setup/jailModeDefault.ts) so the suite never spawns git in a real
    // repo: delete it here to exercise the REAL default (isolation ON).
    for (const k of WT_ENV_KEYS) {
      envBackup[k] = process.env[k];
      delete process.env[k];
    }
    __resetKrakenWorktreeLifecycleForTests();
  });

  afterEach(() => {
    __resetKrakenWorktreeLifecycleForTests();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('a non-git folder keeps running in the shared tree and records WHY', async () => {
    const fallbacks: WorktreeFallbackInfo[] = [];
    const seenCwds: string[] = [];
    const deps: TaskToolDeps = {
      createSubAgentContext: (async ({ cwd }: { cwd: string }) => {
        seenCwds.push(cwd);
        return {
          model: 'm',
          provider: 'p',
          cwd,
          registry: { invoke: async () => ({ output: '' }), fingerprints: () => [], toOpenAITools: () => [] },
          tools: [],
          providerStream: (async function* () {}) as never,
        };
      }) as unknown as TaskToolDeps['createSubAgentContext'],
      harnessFactory: (() =>
        ({
          run: async function* (): AsyncGenerator<BrainEvent> {
            const mk = (e: object) => ({ id: 'e', ts: 0, sessionId: 's', ...e }) as BrainEvent;
            yield mk({ type: 'message_start' });
            yield mk({ type: 'message_delta', delta: 'done' });
            yield mk({ type: 'message_end' });
          },
          cancel: () => {},
        }) as SubAgentHarness) as unknown as TaskToolDeps['harnessFactory'],
      onWorktreeFallback: (info) => fallbacks.push(info),
    };

    const res = await runTentacle({
      deps,
      args: { description: 'impl slice', prompt: 'implement the slice' },
      agent: 'general',
      thoroughness: 'medium',
      parentCwd: dir,
      sessionId: 'ws3-nogit',
      nodeId: 'g1',
    });

    // Fail-open: the tentacle still ran, in the shared parent tree.
    expect(res.ok).toBe(true);
    expect(res.worktreePath).toBeNull();
    expect(seenCwds).toEqual([dir]);
    expect(existsSync(path.join(dir, '.zelari', 'worktrees'))).toBe(false);

    const radio = readKrakenRadio(dir, 'ws3-nogit', 100);
    const fb = radio.find((e) => e.kind === 'worktree.fallback_shared_tree');
    expect(fb, `expected a fallback event, got ${JSON.stringify(radio)}`).toBeTruthy();
    // The reason names the CAUSE, not just "it failed", and the mode is the
    // freshly-flipped default — proof this ran without any env at all.
    expect(fb!.mode).toBe('on');
    expect(fb!.reason).toContain('not-a-git-repo');
    expect(fb!.agent).toBe('general');
    expect(fb!.nodeId).toBe('g1');

    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]!.code).toBe('not-a-git-repo');
    expect(fallbacks[0]!.mode).toBe('on');
    expect(fallbacks[0]!.nodeId).toBe('g1');
  });

  it('explore never asks for a worktree, so it never reports a degradation', async () => {
    const fallbacks: WorktreeFallbackInfo[] = [];
    const deps = {
      createSubAgentContext: async () => ({ ...dummyContext, cwd: dir }),
      harnessFactory: () => fakeHarness(DONE_EVENTS),
      onWorktreeFallback: (info: WorktreeFallbackInfo) => fallbacks.push(info),
    } as unknown as TaskToolDeps;

    const res = await runTentacle({
      deps,
      args: { description: 'scan', prompt: 'scan the tree' },
      agent: 'explore',
      thoroughness: 'medium',
      parentCwd: dir,
      sessionId: 'ws3-explore',
    });

    expect(res.ok).toBe(true);
    expect(fallbacks).toHaveLength(0);
    expect(
      readKrakenRadio(dir, 'ws3-explore', 100).some(
        (e) => e.kind === 'worktree.fallback_shared_tree',
      ),
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 5. Deterministic teardown                                           */
/* ------------------------------------------------------------------ */

describe('WS3 cleanup — retry, guard, coherent branch handling', () => {
  let repo: string;
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'kraken-ws3-clean-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'kraken@zelari.local');
    git(repo, 'config', 'user.name', 'Kraken Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(repo, '.gitignore'), '.zelari/\n');
    writeFileSync(path.join(repo, 'base.txt'), 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    for (const k of WT_ENV_KEYS) {
      envBackup[k] = process.env[k];
      delete process.env[k];
    }
    __resetKrakenWorktreeLifecycleForTests();
  });

  afterEach(() => {
    __resetKrakenWorktreeLifecycleForTests();
    rmSync(repo, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('eager cleanup removes the worktree, deletes the branch, and says what it did', async () => {
    const env: NodeJS.ProcessEnv = { ZELARI_KRAKEN_WORKTREE_CLEANUP: 'eager' };
    const handle = (await createKrakenWorktree(repo, 'alpha')) as WorktreeHandle;
    expect(handle).toBeTruthy();
    expect(existsSync(handle.path)).toBe(true);
    expect(krakenBranches(repo)).toEqual([handle.branch]);

    const outcome = await cleanupKrakenWorktree(handle, env);

    expect(outcome.removed).toBe(true);
    expect(outcome.attempts).toBe(1); // happy path: no retry spent
    expect(outcome.swept).toBe(false); // git removed it, no fs sweep needed
    expect(outcome.branchAction).toBe('deleted');
    expect(outcome.degraded).toBeNull();
    expect(existsSync(handle.path)).toBe(false);
    expect(krakenBranches(repo)).toEqual([]);
  });

  it('inside a run scope the repo-level half is queued instead of spawned', async () => {
    expect(beginKrakenWorktreeCleanupBatch({})).toBe(true);
    const handle = (await createKrakenWorktree(repo, 'beta')) as WorktreeHandle;

    const outcome = await cleanupKrakenWorktree(handle, {});

    expect(outcome.removed).toBe(true);
    expect(outcome.branchAction).toBe('queued');
    expect(existsSync(handle.path)).toBe(false);
    // Directory free immediately; the branch is still there for the flush.
    expect(krakenBranches(repo)).toEqual([handle.branch]);
  });

  it('KEEP=1 makes cleanup a no-op (nothing removed, nothing deleted)', async () => {
    const handle = (await createKrakenWorktree(repo, 'gamma')) as WorktreeHandle;
    const outcome = await cleanupKrakenWorktree(handle, { ZELARI_KRAKEN_WORKTREE_KEEP: '1' });

    expect(outcome.removed).toBe(false);
    expect(outcome.branchAction).toBe('none');
    expect(outcome.degraded).toBeNull();
    expect(existsSync(handle.path)).toBe(true);
    expect(krakenBranches(repo)).toEqual([handle.branch]);
  });

  it('refuses to sweep a path outside .zelari/worktrees and keeps the branch', async () => {
    // A user directory with a user file: a foreign/mangled handle must never
    // be deleted recursively, and `git worktree remove` refuses a directory
    // that is not a worktree, so the sweep is the only thing left — and it
    // must decline.
    execFileSync('git', ['-C', repo, 'branch', 'kraken/foreign'], { stdio: 'ignore' });
    const userDir = path.join(repo, 'docs');
    rmSync(userDir, { recursive: true, force: true });
    mkdirSync(userDir, { recursive: true });
    writeFileSync(path.join(userDir, 'notes.md'), 'user notes\n');

    const handle: WorktreeHandle = {
      id: 'foreign',
      branch: 'kraken/foreign',
      path: userDir,
      repoRoot: repo,
    };
    const outcome = await cleanupKrakenWorktree(handle, {
      ZELARI_KRAKEN_WORKTREE_CLEANUP: 'eager',
    });

    expect(outcome.removed).toBe(false);
    expect(outcome.degraded).toContain('refusing to sweep');
    // Coherent: the directory survived, so its branch is kept (deleting it
    // would orphan the work it might still hold).
    expect(outcome.branchAction).toBe('skipped');
    expect(existsSync(path.join(userDir, 'notes.md'))).toBe(true);
    expect(krakenBranches(repo)).toContain('kraken/foreign');
  });

  it('a worktree whose directory is already gone is reported as removed, branch and all', async () => {
    const env: NodeJS.ProcessEnv = { ZELARI_KRAKEN_WORKTREE_CLEANUP: 'eager' };
    const handle = (await createKrakenWorktree(repo, 'delta')) as WorktreeHandle;
    rmSync(handle.path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

    const outcome = await cleanupKrakenWorktree(handle, env);

    expect(outcome.removed).toBe(true);
    expect(outcome.attempts).toBe(0); // nothing to remove: no git spawn spent
    expect(outcome.branchAction).toBe('deleted');
    expect(krakenBranches(repo)).toEqual([]);
  });
});
