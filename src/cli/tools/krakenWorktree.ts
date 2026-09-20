/**
 * krakenWorktree — git worktree isolation for Kraken general tentacles (K7).
 *
 * WS3 (2.39): isolation is **DEFAULT ON**. A `general` tentacle with write runs in
 * `<repo>/.zelari/worktrees/kraken-<id>` unless the user opts out explicitly:
 *
 *   | ZELARI_KRAKEN_WORKTREE | effect                                             |
 *   |------------------------|----------------------------------------------------|
 *   | unset / '' / any other | ON — isolated worktree (the default)                |
 *   | `1` `true` `yes` `on`  | ON — legacy truthy spellings, unchanged             |
 *   | `auto`                 | ON — plus the graph scheduler may pull overlapping writers forward |
 *   | `0` `false` `no` `off` | OFF — explicit opt-out, runs in the parent tree      |
 *
 * The isolation decision is a PURE function of the env slice
 * (`resolveKrakenWorktreeMode`), so it is testable without spawning anything.
 *
 * Flow:
 *   1. git worktree add <repo>/.zelari/worktrees/kraken-<id> -b kraken/<id>
 *   2. Run sub-agent with cwd = worktree path
 *   3. On success (default): squash-merge branch into parent HEAD, then cleanup
 *      - ZELARI_KRAKEN_WORKTREE_AUTO_MERGE=0 → skip merge (still cleanup unless KEEP)
 *      - ZELARI_KRAKEN_WORKTREE_KEEP=1 → never merge/cleanup: worktree + branch stay
 *        on disk for a manual merge (`git merge <branch>`, then `git worktree remove`)
 *   4. On merge conflict: keep worktree + branch, report error in footer
 *   5. Whenever a worktree cannot be created (not a git repo, no git, add failed)
 *      the tentacle runs in the SHARED parent tree and the reason is reported —
 *      never a silent degradation, never a failed tentacle.
 *
 * WS3 hardening (win32):
 *
 *   - **Long paths**: the fs/`git` calls that touch the worktree path switch on
 *     demand — `\\?\`-prefixed paths for node fs, `-c core.longpaths=true` for
 *     git — but ONLY once a path is ≥ 240 chars, so the normal case keeps the
 *     identical argv/env it had before (existing spawn-count tests included).
 *   - **Cleanup retries**: `git worktree remove --force` and the filesystem
 *     sweep are retried a bounded number of times (default 3) with a short
 *     backoff, because on Windows a file still held by git/AV/an editor fails
 *     with EPERM/EACCES/EBUSY/ENOTEMPTY instead of being deleted.
 *   - **Gitignore-aware sweep**: the recursive delete only ever touches a path
 *     strictly inside `<repo>/.zelari/worktrees/` and named `kraken-*`
 *     (`.zelari/` is gitignored — see .gitignore), so a mangled or foreign
 *     handle can never delete user files outside the worktree root.
 *   - **Coherent teardown**: the branch is deleted (eager) or queued (batched)
 *     ONLY once the worktree directory is actually gone; if the directory
 *     survives, the branch is kept so the work is not orphaned.
 *
 * Int3c (plan v2 §7.3) — lifecycle micro-opts:
 *
 *   1. `git rev-parse --show-toplevel` is MEMOIZED per process (per resolved
 *      cwd): the toplevel of a given directory cannot change while we run, and
 *      every writer paid for that probe at creation time. Only positive
 *      answers are cached — see `resolveGitRoot` for why a null is re-probed.
 *
 *   2. The cleanup is now scoped: the per-writer `worktree remove --force`
 *      stays EAGER (the directory must be free before the next writer), while
 *      the repo-level bookkeeping that used to follow it — one
 *      `git worktree prune` + one `git branch -D <branch>` per removed
 *      worktree — is DEFERRED and coalesced into a single prune + a single
 *      `branch -D <list>` at the end of the run. Only a run that explicitly
 *      opens a scope (`beginKrakenWorktreeCleanupBatch`) defers: outside a
 *      scope nothing would ever flush the queue, so cleanup stays eager there
 *      rather than leaking branches.
 *      Kill-switch `ZELARI_KRAKEN_WORKTREE_CLEANUP=eager` (default `batch`)
 *      restores the old per-worktree behavior for every caller.
 *      Policy + queue live in `kraken/worktreeCleanupBatch.ts` (re-exported
 *      below); this module owns the git calls.
 *
 * Windows: Git for Windows worktree. Paths are absolute.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import {
  __resetKrakenWorktreeCleanupQueueForTests,
  isKrakenWorktreeCleanupBatched,
  queueWorktreeCleanup,
  takeQueuedWorktreeCleanup,
} from '../kraken/worktreeCleanupBatch.js';
import {
  captureParentPreMergeState,
  emitWorktreeMergeAborted,
  formatRollbackMessage,
  rollbackParentAfterFailedMerge,
} from '../kraken/worktreeMergeRollback.js';

/**
 * Cleanup policy + queue live in `kraken/worktreeCleanupBatch.ts` (Int3c):
 * re-exported here so worktree callers keep a single entry point.
 */
export {
  beginKrakenWorktreeCleanupBatch,
  isKrakenWorktreeCleanupBatched,
  resolveWorktreeCleanupMode,
  type KrakenWorktreeCleanupMode,
} from '../kraken/worktreeCleanupBatch.js';

const execFileAsync = promisify(execFile);

export interface WorktreeHandle {
  id: string;
  branch: string;
  path: string;
  repoRoot: string;
  /** HEAD sha at creation (merge base). */
  baseSha?: string;
}

export interface WorktreeMergeResult {
  ok: boolean;
  merged: boolean;
  committed: boolean;
  message: string;
  conflict?: boolean;
}

/**
 * Why a worktree could not be created (WS3 honest degradation). Every one of
 * these means "the tentacle still runs — in the shared parent tree", and the
 * caller reports which one it was instead of degrading silently.
 */
export type KrakenWorktreeFailureCode =
  | 'git-unavailable'
  | 'not-a-git-repo'
  | 'worktree-root-unwritable'
  | 'worktree-add-failed'
  | 'worktree-create-threw';

/** Outcome of an isolation attempt: a handle, or the reason there is none. */
export type KrakenWorktreeCreateResult =
  | { ok: true; handle: WorktreeHandle }
  | { ok: false; code: KrakenWorktreeFailureCode; reason: string };

/** What `cleanupKrakenWorktree` actually did — observed, never assumed. */
export interface KrakenWorktreeCleanupOutcome {
  /** The worktree directory is gone (removed by git, by git+sweep, or absent). */
  removed: boolean;
  /** The recursive sweep ran (git left files behind or failed). */
  swept: boolean;
  /** `git worktree remove --force` invocations spent (>1 ⇒ retried on a lock). */
  attempts: number;
  /** Branch the teardown owned (a `kraken/*` name), or null. */
  branch: string | null;
  /** What happened to that branch: batched, deleted, or deliberately kept. */
  branchAction: 'queued' | 'deleted' | 'skipped' | 'none';
  /** Honest one-liner when teardown could not finish; null on the happy path. */
  degraded: string | null;
}

/** Isolation modes for a general tentacle (WS3). */
export type KrakenWorktreeMode = 'on' | 'off' | 'auto';

/**
 * Values that mean "do NOT isolate" — the explicit opt-out. Everything else
 * (including an empty or unrecognized value) keeps isolation ON: this flag
 * guards the user's working tree, so an unreadable value must fail CLOSED
 * (isolated) rather than silently drop the worktree the repo asked for.
 *
 * Note the deliberate asymmetry with `worktreeScheduling.resolveWorktreeMode`,
 * which resolves the *scheduling* mode and turns an unrecognized value into
 * `off`: there the failure direction that must be avoided is widening
 * parallelism, here it is dropping isolation. Both resolvers fail safe.
 */
const KRAKEN_WORKTREE_OFF_VALUES = new Set(['0', 'false', 'no', 'off', 'disable', 'disabled']);

/**
 * WS3 — pure resolver for the isolation switch. No spawn, no fs, no clock:
 * the caller passes the env slice in (defaults to `process.env` for callers
 * that own the process).
 *
 * `unset`/''/`1`/`true`/`yes`/`on`/anything-else → 'on' (DEFAULT ON since 2.39)
 * `auto` → 'auto' (isolation + the graph scheduler decides which nodes it
 *           rescues in parallel; see `worktreeScheduling.ts`)
 * `0`/`false`/`no`/`off` → 'off' (explicit opt-out: run in the parent tree)
 */
export function resolveKrakenWorktreeMode(
  env: NodeJS.ProcessEnv = process.env,
): KrakenWorktreeMode {
  const v = (env.ZELARI_KRAKEN_WORKTREE ?? '').trim().toLowerCase();
  if (v === 'auto') return 'auto';
  if (KRAKEN_WORKTREE_OFF_VALUES.has(v)) return 'off';
  return 'on';
}

/** True when a general tentacle should run isolated (`on` or `auto`). */
export function isKrakenWorktreeIsolationEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveKrakenWorktreeMode(env) !== 'off';
}

/**
 * LEGACY predicate, kept verbatim for the call sites written before WS3: true
 * only when the raw value is an explicit truthy token, i.e. `false` by default.
 * It no longer drives the isolation decision — `resolveKrakenWorktreeMode()`
 * does (default ON) — so prefer that one for anything new.
 */
export function isKrakenWorktreeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.ZELARI_KRAKEN_WORKTREE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function shouldKeepWorktree(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.ZELARI_KRAKEN_WORKTREE_KEEP ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Auto-merge after a successful general tentacle.
 * Default ON when worktree is enabled and KEEP is off.
 * Set ZELARI_KRAKEN_WORKTREE_AUTO_MERGE=0 to disable.
 */
export function isKrakenWorktreeAutoMergeEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (shouldKeepWorktree(env)) return false;
  const v = (env.ZELARI_KRAKEN_WORKTREE_AUTO_MERGE ?? '1').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return true;
}

/**
 * What a batched cleanup actually did. Honest by construction: the counts are
 * the git invocations issued (and the branches git confirmed deleting), not an
 * estimate — nothing is reported that was not observed.
 */
export interface WorktreeCleanupBatchResult {
  /** `git worktree prune` invocations at flush (≤1 per repo root). */
  pruned: number;
  /** Branch names handed to the batched `git branch -D` (the request). */
  branches: string[];
  /** Of those, the ones git confirmed with `Deleted branch ...`. */
  deleted: string[];
  /** Repo roots the flush touched. */
  repoRoots: string[];
}

/**
 * Issue the deferred repo-level cleanup: one `git worktree prune` per repo
 * root that had a worktree removed, then one `git branch -D <list>` per root.
 *
 * Fail-open by construction: `git()` never throws, so a flush in a `finally`
 * can not mask the error the run is already propagating, and a repo whose
 * prune fails still gets its branch deletion attempted. Never issues a git
 * command when the queue is empty (flush on an idle/eager process = 0 spawns).
 */
export async function flushKrakenWorktreeCleanupBatch(): Promise<WorktreeCleanupBatchResult> {
  const { repoRoots, branchesByRoot } = takeQueuedWorktreeCleanup();

  const branches: string[] = [];
  const deleted: string[] = [];
  let pruned = 0;

  for (const repoRoot of repoRoots) {
    await git(repoRoot, ['worktree', 'prune']);
    pruned += 1;

    const list = branchesByRoot.get(repoRoot);
    if (list && list.length > 0) {
      branches.push(...list);
      const r = await git(repoRoot, ['branch', '-D', ...list]);
      for (const line of r.stdout.split('\n')) {
        const m = /^Deleted branch (\S+)/.exec(line.trim());
        if (m?.[1]) deleted.push(m[1]);
      }
    }
  }

  return { pruned, branches, deleted, repoRoots };
}

/** Test-only: drop the memo, the cleanup queue and any open scope. */
export function __resetKrakenWorktreeLifecycleForTests(): void {
  gitRootMemo.clear();
  __resetKrakenWorktreeCleanupQueueForTests();
}

/* ------------------------------------------------------------------------- */
/* WS3 — win32 hardening helpers                                              */
/* ------------------------------------------------------------------------- */

/** Below this the plain path is safe on Windows too; above it we switch form. */
const LONG_PATH_THRESHOLD = 240;

/** `\\?\`-prefixed (or `\\?\UNC\…`) absolute path. No-op off win32. */
export function toLongPath(target: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return target;
  const abs = path.resolve(target);
  if (abs.startsWith('\\\\?\\')) return abs;
  if (abs.startsWith('\\\\')) return `\\\\?\\UNC\\${abs.slice(2)}`;
  return `\\\\?\\${abs}`;
}

/** True when any of these paths may exceed the win32 MAX_PATH budget. */
export function isLongPath(...targets: string[]): boolean {
  return targets.some((t) => path.resolve(t).length >= LONG_PATH_THRESHOLD);
}

/** Path handed to node fs: extended-length only when the plain form may fail. */
function fsPath(target: string): string {
  return process.platform === 'win32' && isLongPath(target) ? toLongPath(target) : target;
}

/** Retry budget for teardown (`git worktree remove` + the fs sweep). */
export const CLEANUP_MAX_ATTEMPTS = 3;
/** Short backoff between attempts (ms), indexed by attempt - 1. */
export const CLEANUP_BACKOFF_MS: readonly number[] = [25, 75];

/** Codes that mean "a handle is still open": worth another attempt, not a bug. */
const TRANSIENT_CLEANUP_CODES = new Set([
  'EPERM',
  'EACCES',
  'EBUSY',
  'ENOTEMPTY',
  'EEXIST',
  'EMFILE',
  'ENFILE',
]);

/** True for the Windows lock/permission failures a retry can actually clear. */
export function isRetryableCleanupError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && TRANSIENT_CLEANUP_CODES.has(code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The ONLY kind of path a recursive cleanup sweep may delete: strictly inside
 * `<repoRoot>/.zelari/worktrees/` and named like a kraken worktree. `.zelari/`
 * is gitignored (`.gitignore`), so a sweep can never reach user files, and a
 * mangled handle — or one pointing at the parent tree — is refused instead of
 * deleted. The worktrees root itself and anything above it return false.
 */
export function isInsideKrakenWorktrees(target: string, repoRoot: string): boolean {
  const root = path.resolve(repoRoot, '.zelari', 'worktrees');
  const resolved = path.resolve(target);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return path.basename(resolved).startsWith('kraken-');
}

/**
 * Bounded retry around one recursive delete. A missing target counts as
 * success. `opts.remove`/`opts.sleep` exist so tests can drive the retry path
 * deterministically without depending on a real Windows file lock; production
 * always runs the defaults (`rmSync` on the extended-length path when needed).
 */
export async function removePathWithRetry(
  target: string,
  opts: {
    attempts?: number;
    backoffMs?: readonly number[];
    remove?: (p: string) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ removed: boolean; attempts: number; lastError: string | null }> {
  const attempts = opts.attempts ?? CLEANUP_MAX_ATTEMPTS;
  const backoff = opts.backoffMs ?? CLEANUP_BACKOFF_MS;
  const remove =
    opts.remove ?? ((p: string) => rmSync(fsPath(p), { recursive: true, force: true }));
  const wait = opts.sleep ?? sleep;

  let lastError: string | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      remove(target);
      if (!existsSync(fsPath(target))) return { removed: true, attempts: attempt, lastError: null };
      lastError = 'directory still present after rmSync';
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') {
        return { removed: true, attempts: attempt, lastError: null };
      }
      lastError = `${(err as { code?: string }).code ?? 'error'}: ${
        err instanceof Error ? err.message : String(err)
      }`;
      // Not a lock/perm failure: retrying a genuine error only wastes time.
      if (!isRetryableCleanupError(err)) break;
    }
    if (attempt < attempts) await wait(backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 0);
  }
  return { removed: !existsSync(fsPath(target)), attempts, lastError };
}

/** Result of one `git` invocation; `errno` is set for spawn failures (ENOENT = no git). */
interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
  errno?: string;
}

/**
 * Run git in `cwd`. `opts.longPaths` (win32 only) prepends
 * `-c core.longpaths=true` and is passed ONLY by the call sites that can hand
 * git a path past MAX_PATH — ordinary invocations keep the exact argv the
 * existing spawn-count suites assert on.
 */
async function git(
  cwd: string,
  args: string[],
  opts: { longPaths?: boolean } = {},
): Promise<GitResult> {
  const prefix =
    opts.longPaths && process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : [];
  try {
    const { stdout, stderr } = await execFileAsync('git', [...prefix, '-C', cwd, ...args], {
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, stdout: stdout ?? '', stderr: stderr ?? '', code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: number | string };
    return {
      ok: false,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? String(err),
      code: typeof e.code === 'number' ? e.code : 1,
      ...(typeof e.code === 'string' ? { errno: e.code } : {}),
    };
  }
}

/**
 * Int3c: `resolved cwd → git toplevel`. Module-level on purpose: every writer
 * of a run resolves the SAME parent cwd, and the answer cannot change under
 * us. Bounded by the number of distinct cwds a process touches (a handful).
 */
const gitRootMemo = new Map<string, string>();

/** Resolve git toplevel for worktree add.
 *
 * Int3c: memoized per resolved cwd. The toplevel of a directory is a property
 * of the filesystem layout, not of the run, so re-probing it for every writer
 * was pure subprocess cost. Negative answers are deliberately NOT cached: a
 * cwd that is not a repo yet (a fresh temp dir, or a run that includes
 * `git init`) can become one mid-process, and a cached null would silently
 * disable worktree isolation for the rest of the process.
 *
 * Callers that need the probe repeated (tests) can call
 * `__resetKrakenWorktreeLifecycleForTests()`.
 */
export async function resolveGitRootDetailed(
  cwd: string,
): Promise<{ root: string | null; reason: KrakenWorktreeFailureCode | null }> {
  const key = path.resolve(cwd);
  const memo = gitRootMemo.get(key);
  if (memo) return { root: memo, reason: null };

  const r = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!r.ok) {
    // ENOENT = the `git` binary itself is missing (CI image, minimal container).
    return { root: null, reason: r.errno === 'ENOENT' ? 'git-unavailable' : 'not-a-git-repo' };
  }
  const root = r.stdout.trim();
  if (!root) return { root: null, reason: 'not-a-git-repo' };
  gitRootMemo.set(key, root);
  return { root, reason: null };
}

export async function resolveGitRoot(cwd: string): Promise<string | null> {
  return (await resolveGitRootDetailed(cwd)).root;
}

/**
 * Create an isolated worktree for a general tentacle, reporting WHY when it
 * cannot (WS3): the caller keeps running in the shared parent tree, but it
 * publishes the reason instead of silently losing isolation.
 */
export async function createKrakenWorktreeDetailed(
  cwd: string,
  label?: string,
): Promise<KrakenWorktreeCreateResult> {
  const probe = await resolveGitRootDetailed(cwd);
  if (!probe.root) {
    const code: KrakenWorktreeFailureCode = probe.reason ?? 'not-a-git-repo';
    return {
      ok: false,
      code,
      reason:
        code === 'git-unavailable'
          ? 'git executable not found on PATH'
          : `no git toplevel for ${path.resolve(cwd)}`,
    };
  }
  const repoRoot = probe.root;

  const head = await git(repoRoot, ['rev-parse', 'HEAD']);
  const baseSha = head.ok ? head.stdout.trim() : undefined;

  const id = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const slug =
    (label ?? 'task')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24) || 'task';
  const branch = `kraken/${slug}-${id}`;
  const wtRoot = path.join(repoRoot, '.zelari', 'worktrees');
  const wtPath = path.join(wtRoot, `kraken-${id}`);
  // win32: only switch git/fs into extended-length mode when this worktree
  // path (or its repo root) can actually exceed MAX_PATH.
  const longPaths = isLongPath(repoRoot, wtPath);

  try {
    if (!existsSync(fsPath(wtRoot))) mkdirSync(fsPath(wtRoot), { recursive: true });
  } catch (err) {
    return {
      ok: false,
      code: 'worktree-root-unwritable',
      reason: `cannot create ${wtRoot}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const add = await git(repoRoot, ['worktree', 'add', '-b', branch, wtPath, 'HEAD'], { longPaths });
  if (!add.ok) {
    // Detached retry: an existing `kraken/<slug>-<id>` name (or a git that
    // refuses `-b` on this object format) still gets isolation, just without
    // a mergeable branch name — the handle says `HEAD`, and cleanup knows not
    // to delete a branch in that case.
    const add2 = await git(repoRoot, ['worktree', 'add', wtPath, 'HEAD'], { longPaths });
    if (!add2.ok) {
      return {
        ok: false,
        code: 'worktree-add-failed',
        reason: `git worktree add failed: ${(add2.stderr || add.stderr).trim().slice(0, 300)}`,
      };
    }
    return { ok: true, handle: { id, branch: 'HEAD', path: wtPath, repoRoot, baseSha } };
  }

  return { ok: true, handle: { id, branch, path: wtPath, repoRoot, baseSha } };
}

/**
 * Create an isolated worktree for a general tentacle.
 * Returns null if git unavailable or worktree add fails (caller falls back to shared cwd).
 * Prefer {@link createKrakenWorktreeDetailed} when the caller can report the reason.
 */
export async function createKrakenWorktree(
  cwd: string,
  label?: string,
): Promise<WorktreeHandle | null> {
  const created = await createKrakenWorktreeDetailed(cwd, label);
  return created.ok ? created.handle : null;
}

/**
 * Commit dirty files inside the worktree (best-effort).
 */
export async function commitWorktreeChanges(
  handle: WorktreeHandle,
  message: string,
): Promise<{ ok: boolean; committed: boolean; detail: string }> {
  const longPaths = isLongPath(handle.path);
  const opts = { longPaths };
  const st = await git(handle.path, ['status', '--porcelain'], opts);
  if (!st.ok) return { ok: false, committed: false, detail: st.stderr || 'status failed' };

  if (st.stdout.trim()) {
    const add = await git(handle.path, ['add', '-A'], opts);
    if (!add.ok) return { ok: false, committed: false, detail: add.stderr || 'add failed' };
    const msg = message.slice(0, 200) || `kraken tentacle ${handle.id}`;
    const commit = await git(handle.path, [
      'commit',
      '-m',
      msg,
      '--author',
      'Kraken Tentacle <kraken@zelari.local>',
    ], opts);
    if (!commit.ok) {
      const st2 = await git(handle.path, ['status', '--porcelain'], opts);
      if (st2.ok && !st2.stdout.trim()) {
        return { ok: true, committed: false, detail: 'clean after add' };
      }
      return { ok: false, committed: false, detail: commit.stderr || 'commit failed' };
    }
    return { ok: true, committed: true, detail: 'committed in worktree' };
  }

  return { ok: true, committed: false, detail: 'worktree clean' };
}

/**
 * Squash-merge tentacle branch into the parent repo HEAD, then optionally cleanup.
 */
export async function mergeKrakenWorktree(
  handle: WorktreeHandle,
  opts: { message?: string; cleanup?: boolean; sessionId?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorktreeMergeResult> {
  if (!handle.branch || handle.branch === 'HEAD') {
    return {
      ok: false,
      merged: false,
      committed: false,
      message: 'worktree has no named branch to merge',
    };
  }

  const commitMsg = (opts.message ?? `kraken: merge ${handle.branch}`).slice(0, 200);
  const abortBase = {
    repoRoot: handle.repoRoot,
    branch: handle.branch,
    nodeId: handle.id,
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
  };

  const pre = await commitWorktreeChanges(handle, commitMsg);
  if (!pre.ok) {
    // The worktree commit writes a different tree — no parent mutation has
    // happened yet, so there is nothing to roll back, but the abort is still
    // signalled so the audit trail is uniform (K2.3 req.4).
    emitWorktreeMergeAborted({
      ...abortBase,
      reason: `pre-merge commit failed: ${pre.detail}`,
      phase: 'worktree-commit',
    });
    return {
      ok: false,
      merged: false,
      committed: false,
      message: `pre-merge commit failed: ${pre.detail}`,
    };
  }

  const range = handle.baseSha
    ? `${handle.baseSha}..${handle.branch}`
    : handle.branch;
  const log = await git(handle.repoRoot, ['log', '--oneline', range]);
  const ahead = log.ok ? log.stdout.trim() : '';
  if (!ahead && !pre.committed) {
    if (opts.cleanup !== false && !shouldKeepWorktree(env)) {
      await cleanupKrakenWorktree(handle, env);
    }
    return {
      ok: true,
      merged: false,
      committed: false,
      message: 'no changes to merge (worktree empty)',
    };
  }

  // K2.3 / F11 — recovery point: the parent tree exactly as it stands BEFORE
  // the squash touches it. `git merge --squash` below is the first parent
  // mutation, so any failure past this line (conflict, denied commit, partial
  // copy) rolls back to `preParent` instead of leaving a half-squashed tree.
  const preParent = await captureParentPreMergeState(handle.repoRoot);

  const merge = await git(handle.repoRoot, ['merge', '--squash', handle.branch]);
  if (!merge.ok) {
    const reason = `merge conflict or failed: ${(merge.stderr || merge.stdout).trim().slice(0, 300)}`;
    const rb = await rollbackParentAfterFailedMerge({
      ...abortBase,
      reason,
      phase: 'squash',
      pre: preParent,
    });
    return {
      ok: false,
      merged: false,
      committed: false,
      conflict: true,
      message: formatRollbackMessage('merge conflict or failed', rb, handle.branch),
    };
  }

  const stParent = await git(handle.repoRoot, ['status', '--porcelain']);
  let committed = false;
  if (stParent.ok && stParent.stdout.trim()) {
    const c = await git(handle.repoRoot, ['commit', '-m', commitMsg]);
    if (!c.ok) {
      const rb = await rollbackParentAfterFailedMerge({
        ...abortBase,
        reason: `squash staged but commit failed: ${c.stderr.trim().slice(0, 200)}`,
        phase: 'commit',
        pre: preParent,
      });
      return {
        ok: false,
        merged: true,
        committed: false,
        message: formatRollbackMessage('squash staged but commit failed', rb, handle.branch),
      };
    }
    committed = true;
  }

  if (opts.cleanup !== false && !shouldKeepWorktree(env)) {
    await cleanupKrakenWorktree(handle, env);
  }

  return {
    ok: true,
    merged: true,
    committed,
    message: committed
      ? `squash-merged ${handle.branch} into HEAD`
      : `squash-merge ${handle.branch} (no parent commit — already applied?)`,
  };
}

/**
 * Remove worktree + delete branch (best-effort).
 * Skipped when ZELARI_KRAKEN_WORKTREE_KEEP=1.
 *
 * Int3c split: the `worktree remove --force` (plus the filesystem sweep) is
 * ALWAYS eager — the directory has to be gone before the next writer, and a
 * merge node may run right after. Only the repo-level bookkeeping is
 * deferred when a run scope is open: one `worktree prune` and one
 * `branch -D` per worktree become a single pair at flush time.
 */
export async function cleanupKrakenWorktree(
  handle: WorktreeHandle,
  env: NodeJS.ProcessEnv = process.env,
): Promise<KrakenWorktreeCleanupOutcome> {
  if (shouldKeepWorktree(env)) {
    // KEEP=1: the caller owns the worktree now (manual merge + manual remove).
    return {
      removed: false,
      swept: false,
      attempts: 0,
      branch: null,
      branchAction: 'none',
      degraded: null,
    };
  }

  const longPaths = isLongPath(handle.repoRoot, handle.path);
  let removed = !existsSync(fsPath(handle.path));
  let lastError: string | null = null;
  let attempts = 0;

  // WS3: bounded retry. On Windows `git worktree remove --force` fails with
  // EPERM/EBUSY while git itself, an AV scanner or an editor still holds a
  // file in the tree; the lock is usually gone a few ms later.
  while (!removed && attempts < CLEANUP_MAX_ATTEMPTS) {
    attempts += 1;
    const r = await git(handle.repoRoot, ['worktree', 'remove', '--force', handle.path], {
      longPaths,
    });
    removed = !existsSync(fsPath(handle.path));
    if (!removed) {
      lastError = (r.stderr || r.stdout || `git worktree remove exited ${r.code}`)
        .trim()
        .slice(0, 200);
      if (attempts < CLEANUP_MAX_ATTEMPTS) {
        await sleep(CLEANUP_BACKOFF_MS[Math.min(attempts - 1, CLEANUP_BACKOFF_MS.length - 1)] ?? 0);
      }
    }
  }

  // Filesystem sweep — only as a fallback, and only inside the gitignored
  // worktrees root: nothing here may ever delete a user path.
  let swept = false;
  if (!removed) {
    if (isInsideKrakenWorktrees(handle.path, handle.repoRoot)) {
      swept = true;
      const sweep = await removePathWithRetry(handle.path);
      removed = sweep.removed;
      if (!removed) lastError = sweep.lastError ?? lastError;
    } else {
      lastError = `refusing to sweep ${handle.path}: not inside <repo>/.zelari/worktrees`;
    }
  }

  const branch = handle.branch.startsWith('kraken/') ? handle.branch : null;

  if (!removed) {
    // The directory survived every attempt: its branch is still checked out
    // there (git would refuse `branch -D` anyway), so keep it and report the
    // degradation instead of orphaning the work.
    return {
      removed: false,
      swept,
      attempts,
      branch,
      branchAction: branch ? 'skipped' : 'none',
      degraded: lastError ?? 'worktree directory still present after retries',
    };
  }

  if (isKrakenWorktreeCleanupBatched(env)) {
    // Queue instead of spawning: prune is idempotent and order-independent
    // (it drops the admin entries of worktrees already removed), and the
    // branch is unreachable once its worktree is gone, so deferring both to
    // the end of the run changes nothing except the subprocess count.
    queueWorktreeCleanup(handle.repoRoot, branch);
    return {
      removed: true,
      swept,
      attempts,
      branch,
      branchAction: branch ? 'queued' : 'none',
      degraded: null,
    };
  }

  await git(handle.repoRoot, ['worktree', 'prune'], { longPaths });
  if (!branch) {
    // Detached fallback handle (`worktree add <path> HEAD`): no branch to delete.
    return { removed: true, swept, attempts, branch: null, branchAction: 'none', degraded: null };
  }

  const del = await git(handle.repoRoot, ['branch', '-D', branch]);
  if (!del.ok) {
    return {
      removed: true,
      swept,
      attempts,
      branch,
      branchAction: 'skipped',
      degraded: `branch -D ${branch} failed: ${(del.stderr || del.stdout).trim().slice(0, 200)}`,
    };
  }
  return { removed: true, swept, attempts, branch, branchAction: 'deleted', degraded: null };
}

/** One-line status for task result footer. */
export function formatWorktreeFooter(
  handle: WorktreeHandle,
  opts: { kept?: boolean; merge?: WorktreeMergeResult | null } = {},
): string {
  const merge = opts.merge;
  if (merge) {
    const flag = merge.ok ? 'ok' : merge.conflict ? 'CONFLICT' : 'fail';
    return `worktree merge [${flag}]: ${merge.message} (branch=${handle.branch})`;
  }
  if (opts.kept) {
    return `worktree kept: branch=${handle.branch} path=${handle.path} (merge manually, then git worktree remove)`;
  }
  return `worktree used: branch=${handle.branch} path=${handle.path}`;
}
