/**
 * K2.3 / F11 — roll the parent tree back when a Kraken worktree squash-merge
 * fails after staging (commit denied, conflict, or any post-staging step).
 *
 * Radio names ride in `description` (same pattern as K2.1 bash-write):
 * `worktree.merge_aborted` / `worktree.merge_abort_failed`. Kind stays `error`
 * so we do not have to widen KrakenRadioKind.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { appendKrakenRadio } from '../tools/krakenRadio.js';

const execFileAsync = promisify(execFile);

export const WORKTREE_MERGE_ABORTED = 'worktree.merge_aborted' as const;
export const WORKTREE_MERGE_ABORT_FAILED = 'worktree.merge_abort_failed' as const;

/**
 * Where in the merge pipeline the abort happened. `worktree-commit` is the
 * only PRE-mutation phase (the worktree commit writes a different tree — no
 * parent state has moved yet); `squash` and `commit` are the parent-mutating
 * phases that must roll back.
 */
export type MergeAbortPhase = 'worktree-commit' | 'squash' | 'commit';

/**
 * K2.3 req.4 — signal an abort that happened BEFORE the first parent mutation:
 * there is nothing to roll back, but the audit trail stays uniform (every
 * aborted merge emits `worktree.merge_aborted`).
 */
export function emitWorktreeMergeAborted(opts: {
  repoRoot: string;
  branch: string;
  reason: string;
  phase: MergeAbortPhase;
  nodeId?: string;
  sessionId?: string;
}): void {
  emitRadio(opts.repoRoot, opts.sessionId ?? '', WORKTREE_MERGE_ABORTED, {
    branch: opts.branch,
    reason: opts.reason,
    phase: opts.phase,
    ...(opts.nodeId !== undefined ? { nodeId: opts.nodeId } : {}),
  });
}

export type GitRun = (
  cwd: string,
  args: string[],
) => Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>;

export async function defaultGitRun(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['-C', cwd, ...args], {
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, stdout: stdout ?? '', stderr: stderr ?? '', code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: number };
    return {
      ok: false,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? String(err),
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

export type RollbackAction =
  | 'reset-hard'
  | 'reset-hard-restore-dirty'
  | 'reset-mixed'
  | 'none-no-parent-commit';

export interface DirtySnapshot {
  kind: 'file' | 'missing';
  content?: Buffer;
}

export interface ParentPreMergeState {
  head: string | null;
  dirtyPaths: string[];
  snapshots: Map<string, DirtySnapshot>;
  porcelain: string;
  /** Status/snapshot incomplete — must not `--hard` (would guess at cleanliness). */
  ambiguous: boolean;
}

export interface MergeRollbackResult {
  ok: boolean;
  action: RollbackAction;
  dirtyPathsLeft: string[];
  stderr?: string;
}

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export function parsePorcelainZ(raw: string): string[] {
  const paths: string[] = [];
  const chunks = raw.split('\0');
  let i = 0;
  while (i < chunks.length) {
    const entry = chunks[i];
    i += 1;
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const p = entry.length >= 3 && entry[2] === ' ' ? entry.slice(3) : entry.slice(2).trim();
    if (p) paths.push(p.replace(/\\/g, '/'));
    const isRename = code.includes('R') || code.includes('C');
    if (isRename && i < chunks.length) {
      const orig = chunks[i];
      i += 1;
      if (orig) paths.push(orig.replace(/\\/g, '/'));
    }
  }
  return [...new Set(paths)];
}

function safeJoin(root: string, rel: string): string | null {
  const resolvedRoot = path.resolve(root);
  const abs = path.resolve(root, rel);
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (abs !== resolvedRoot && !abs.startsWith(prefix)) return null;
  return abs;
}

function snapshotPath(repoRoot: string, rel: string): DirtySnapshot {
  const abs = safeJoin(repoRoot, rel);
  if (!abs || !existsSync(abs)) return { kind: 'missing' };
  try {
    const content = readFileSync(abs);
    if (content.length > MAX_SNAPSHOT_BYTES) return { kind: 'missing' };
    return { kind: 'file', content };
  } catch {
    return { kind: 'missing' };
  }
}

export async function captureParentPreMergeState(
  repoRoot: string,
  git: GitRun = defaultGitRun,
): Promise<ParentPreMergeState> {
  const headRun = await git(repoRoot, ['rev-parse', 'HEAD']);
  const head = headRun.ok ? headRun.stdout.trim() : null;
  const st = await git(repoRoot, ['status', '--porcelain', '-z']);
  if (!st.ok) {
    return {
      head: head && head.length > 0 ? head : null,
      dirtyPaths: [],
      snapshots: new Map(),
      porcelain: st.stderr,
      ambiguous: true,
    };
  }
  const dirtyPaths = parsePorcelainZ(st.stdout);
  const snapshots = new Map<string, DirtySnapshot>();
  let ambiguous = false;
  for (const rel of dirtyPaths) {
    const snap = snapshotPath(repoRoot, rel);
    snapshots.set(rel, snap);
    const abs = safeJoin(repoRoot, rel);
    if (abs && existsSync(abs) && snap.kind === 'missing') ambiguous = true;
  }
  return {
    head: head && head.length > 0 ? head : null,
    dirtyPaths,
    snapshots,
    porcelain: st.stdout,
    ambiguous,
  };
}

function restoreSnapshots(repoRoot: string, snapshots: Map<string, DirtySnapshot>): string[] {
  const failed: string[] = [];
  for (const [rel, snap] of snapshots) {
    const abs = safeJoin(repoRoot, rel);
    if (!abs) {
      failed.push(rel);
      continue;
    }
    try {
      if (snap.kind === 'missing') {
        if (existsSync(abs)) rmSync(abs, { recursive: true, force: true });
        continue;
      }
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, snap.content ?? Buffer.alloc(0));
    } catch {
      failed.push(rel);
    }
  }
  return failed;
}

async function leftoverUntracked(
  repoRoot: string,
  keep: Set<string>,
  git: GitRun,
): Promise<string[]> {
  const st = await git(repoRoot, ['status', '--porcelain', '-z']);
  if (!st.ok) return [];
  const now = parsePorcelainZ(st.stdout);
  const removed: string[] = [];
  for (const rel of now) {
    if (keep.has(rel)) continue;
    const abs = safeJoin(repoRoot, rel);
    if (!abs || !existsSync(abs)) continue;
    try {
      rmSync(abs, { recursive: true, force: true });
      removed.push(rel);
    } catch {
      // leave it; caller will report leftover porcelain
    }
  }
  return removed;
}

function emitRadio(
  repoRoot: string,
  sessionId: string,
  description: typeof WORKTREE_MERGE_ABORTED | typeof WORKTREE_MERGE_ABORT_FAILED,
  payload: Record<string, unknown>,
): void {
  appendKrakenRadio(repoRoot, sessionId, {
    kind: 'error',
    agent: 'kraken-worktree',
    description,
    detail: JSON.stringify(payload),
    worktree: typeof payload.branch === 'string' ? payload.branch : null,
    ok: false,
  });
}

export function formatRollbackMessage(
  reason: string,
  rb: MergeRollbackResult,
  branch: string,
): string {
  const kept = `worktree branch ${branch} kept`;
  if (!rb.ok) {
    return `${reason}; rollback FAILED (${(rb.stderr ?? '').trim().slice(0, 200)}). parent may be dirty. ${kept}`;
  }
  if (rb.action === 'none-no-parent-commit') {
    return `${reason}; parent has no commit — skipped reset (would be blind). ${kept}`;
  }
  const dirty =
    rb.dirtyPathsLeft.length > 0
      ? `; preserved/left dirty: ${rb.dirtyPathsLeft.slice(0, 20).join(', ')}`
      : '';
  return `${reason}; rolled back via ${rb.action}${dirty}. ${kept}`;
}

export async function rollbackParentAfterFailedMerge(opts: {
  repoRoot: string;
  branch: string;
  reason: string;
  phase: MergeAbortPhase;
  nodeId?: string;
  pre: ParentPreMergeState;
  sessionId?: string;
  git?: GitRun;
}): Promise<MergeRollbackResult> {
  const git = opts.git ?? defaultGitRun;
  const sessionId = opts.sessionId ?? '';
  const basePayload = {
    branch: opts.branch,
    reason: opts.reason,
    phase: opts.phase,
    ...(opts.nodeId !== undefined ? { nodeId: opts.nodeId } : {}),
  };

  if (!opts.pre.head) {
    const result: MergeRollbackResult = {
      ok: true,
      action: 'none-no-parent-commit',
      dirtyPathsLeft: opts.pre.dirtyPaths,
    };
    emitRadio(opts.repoRoot, sessionId, WORKTREE_MERGE_ABORTED, {
      ...basePayload,
      action: result.action,
      dirtyPathsLeft: result.dirtyPathsLeft,
    });
    return result;
  }

  if (opts.pre.ambiguous) {
    const mixed = await git(opts.repoRoot, ['reset']);
    if (!mixed.ok) {
      const stderr = (mixed.stderr || mixed.stdout).trim();
      emitRadio(opts.repoRoot, sessionId, WORKTREE_MERGE_ABORT_FAILED, {
        ...basePayload,
        action: 'reset-mixed',
        stderr,
      });
      return { ok: false, action: 'reset-mixed', dirtyPathsLeft: opts.pre.dirtyPaths, stderr };
    }
    const st = await git(opts.repoRoot, ['status', '--porcelain', '-z']);
    const left = st.ok ? parsePorcelainZ(st.stdout) : opts.pre.dirtyPaths;
    const result: MergeRollbackResult = { ok: true, action: 'reset-mixed', dirtyPathsLeft: left };
    emitRadio(opts.repoRoot, sessionId, WORKTREE_MERGE_ABORTED, {
      ...basePayload,
      action: result.action,
      dirtyPathsLeft: left,
    });
    return result;
  }

  const wasDirty = opts.pre.dirtyPaths.length > 0;
  const hard = await git(opts.repoRoot, ['reset', '--hard', opts.pre.head]);
  if (!hard.ok) {
    const stderr = (hard.stderr || hard.stdout).trim();
    emitRadio(opts.repoRoot, sessionId, WORKTREE_MERGE_ABORT_FAILED, {
      ...basePayload,
      action: wasDirty ? 'reset-hard-restore-dirty' : 'reset-hard',
      stderr,
    });
    return {
      ok: false,
      action: wasDirty ? 'reset-hard-restore-dirty' : 'reset-hard',
      dirtyPathsLeft: opts.pre.dirtyPaths,
      stderr,
    };
  }

  await leftoverUntracked(opts.repoRoot, new Set(opts.pre.dirtyPaths), git);

  if (wasDirty) {
    const failed = restoreSnapshots(opts.repoRoot, opts.pre.snapshots);
    const result: MergeRollbackResult = {
      ok: failed.length === 0,
      action: 'reset-hard-restore-dirty',
      dirtyPathsLeft: opts.pre.dirtyPaths,
      ...(failed.length > 0 ? { stderr: `restore failed: ${failed.join(', ')}` } : {}),
    };
    emitRadio(
      opts.repoRoot,
      sessionId,
      result.ok ? WORKTREE_MERGE_ABORTED : WORKTREE_MERGE_ABORT_FAILED,
      {
        ...basePayload,
        action: result.action,
        dirtyPathsLeft: result.dirtyPathsLeft,
        ...(result.stderr ? { stderr: result.stderr } : {}),
      },
    );
    return result;
  }

  const result: MergeRollbackResult = { ok: true, action: 'reset-hard', dirtyPathsLeft: [] };
  emitRadio(opts.repoRoot, sessionId, WORKTREE_MERGE_ABORTED, {
    ...basePayload,
    action: result.action,
    dirtyPathsLeft: [],
  });
  return result;
}
