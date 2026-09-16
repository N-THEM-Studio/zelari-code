import { useEffect, useRef, useState } from 'react';
import { execFile } from 'node:child_process';

/**
 * useGitChanges — reactive snapshot of the working-tree changes for the
 * Sidebar (v0.7.9).
 *
 * Polls `git` in the cwd (default 4s while the panel is being watched, see
 * CADENCE below):
 *   - `git rev-parse --abbrev-ref HEAD`        → branch name
 *   - `git diff --numstat` + `--cached`        → per-file +added/-removed
 *   - `git status --porcelain=v1`              → untracked files
 *
 * Everything is best-effort: a missing git binary, a non-repo cwd, or a
 * transient lock error simply yields `isRepo: false` / the previous
 * snapshot. State is only updated when the snapshot actually changed, so
 * the poll does NOT cause an Ink repaint every tick.
 *
 * CADENCE (v2.34, slice 7 of the input-lag diagnosis): the loop used to run
 * flat out at 4s forever — four `git` processes a minute, on every terminal,
 * even with the sidebar hidden and nothing moving. It is now adaptive:
 *   - the FIRST refresh is still immediate (unchanged behaviour);
 *   - `hot` (sidebar open, turn in flight) holds the fast `pollMs` cadence —
 *     the reader is watching, so the chip must stay current;
 *   - otherwise, after `idleAfterTicks` consecutive unchanged snapshots the
 *     loop idles down to `idlePollMs` (20s), and any change — or a `hot` flip —
 *     puts it straight back on the fast cadence.
 * The data still lands on the same code path: only the timer changes.
 */

export interface GitFileChange {
  /** Repo-relative path (renames collapse to the new path). */
  path: string;
  /** Lines added; null for binary files. */
  added: number | null;
  /** Lines removed; null for binary files. */
  removed: number | null;
  /** True for `??` entries (not yet tracked — no numstat available). */
  untracked: boolean;
}

export interface GitChanges {
  isRepo: boolean;
  branch: string | null;
  files: GitFileChange[];
}

export const EMPTY_GIT_CHANGES: GitChanges = { isRepo: false, branch: null, files: [] };

/**
 * Parse `git diff --numstat` output: `added\tremoved\tpath` per line.
 * Binary files report `-\t-\tpath` → added/removed become null.
 * Renames come through as `old => new` or `prefix{old => new}suffix` —
 * collapsed to the new path.
 */
export function parseNumstat(out: string): GitFileChange[] {
  const files: GitFileChange[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [a, r] = parts;
    const rawPath = parts.slice(2).join('\t');
    files.push({
      path: normalizeRenamePath(rawPath),
      added: a === '-' ? null : Number.parseInt(a, 10),
      removed: r === '-' ? null : Number.parseInt(r, 10),
      untracked: false,
    });
  }
  return files;
}

/** Collapse git rename notation (`a/{old => new}/b`, `old => new`) to the new path. */
export function normalizeRenamePath(p: string): string {
  const braced = p.match(/^(.*)\{.* => (.*)\}(.*)$/);
  if (braced) return `${braced[1]}${braced[2]}${braced[3]}`.replace(/\/\//g, '/');
  const arrow = p.match(/^.* => (.*)$/);
  if (arrow) return arrow[1];
  return p;
}

/** Extract untracked paths (`?? path`) from `git status --porcelain=v1`. */
export function parseUntracked(out: string): string[] {
  const paths: string[] = [];
  for (const line of out.split('\n')) {
    if (!line.startsWith('?? ')) continue;
    let p = line.slice(3);
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    paths.push(p);
  }
  return paths;
}

/**
 * Merge unstaged + staged numstat entries (summing counts per path) and
 * append untracked files. Sorted by churn (added+removed) descending so the
 * Sidebar shows the hottest files first; untracked files sort last.
 */
export function mergeChanges(
  unstaged: GitFileChange[],
  staged: GitFileChange[],
  untrackedPaths: string[],
): GitFileChange[] {
  const byPath = new Map<string, GitFileChange>();
  for (const f of [...unstaged, ...staged]) {
    const prev = byPath.get(f.path);
    if (!prev) {
      byPath.set(f.path, { ...f });
    } else {
      prev.added = prev.added === null || f.added === null ? null : prev.added + f.added;
      prev.removed = prev.removed === null || f.removed === null ? null : prev.removed + f.removed;
    }
  }
  for (const p of untrackedPaths) {
    if (!byPath.has(p)) {
      byPath.set(p, { path: p, added: null, removed: null, untracked: true });
    }
  }
  const churn = (f: GitFileChange) =>
    f.untracked ? -1 : (f.added ?? 0) + (f.removed ?? 0);
  return [...byPath.values()].sort((a, b) => churn(b) - churn(a));
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

async function snapshotGitChanges(cwd: string): Promise<GitChanges> {
  let branch: string | null = null;
  try {
    branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim() || null;
  } catch {
    // Not a repo (or no commits yet) — porcelain below settles it.
  }
  let status: string;
  try {
    status = await runGit(['status', '--porcelain=v1'], cwd);
  } catch {
    return EMPTY_GIT_CHANGES; // not a repo / git missing
  }
  const [unstaged, staged] = await Promise.all([
    runGit(['diff', '--numstat'], cwd).catch(() => ''),
    runGit(['diff', '--numstat', '--cached'], cwd).catch(() => ''),
  ]);
  return {
    isRepo: true,
    branch,
    files: mergeChanges(parseNumstat(unstaged), parseNumstat(staged), parseUntracked(status)),
  };
}

/**
 * Fast cadence: the sidebar chip is live-ish while the reader watches.
 * (Unchanged from the pre-slice value.)
 */
export const GIT_POLL_MS = 4000;

/**
 * Idle cadence: what the loop settles on when nothing has changed for
 * `GIT_IDLE_AFTER_TICKS` snapshots in a row and nobody is watching. Still
 * fresh enough that an out-of-band edit shows up within ~20s, at a fifth of
 * the process churn.
 */
export const GIT_IDLE_POLL_MS = 20_000;

/** Unchanged snapshots tolerated at the fast cadence before idling down (12s). */
export const GIT_IDLE_AFTER_TICKS = 3;

export interface UseGitChangesOptions {
  /** Fast cadence, and the cadence kept while `hot`. */
  pollMs?: number;
  /** Cadence after `idleAfterTicks` unchanged snapshots. */
  idlePollMs?: number;
  /** Unchanged snapshots in a row before the loop idles down. */
  idleAfterTicks?: number;
  /**
   * True while someone is watching (sidebar on screen) or while a turn is
   * writing files: holds the fast cadence, and forces an immediate refresh
   * when it flips, so the chip is never stale when the panel opens.
   */
  hot?: boolean;
  cwd?: string;
  /** Injected snapshot source — tests never spawn `git`. */
  snapshot?: (cwd: string) => Promise<GitChanges>;
}

/** Delay before the next poll: fast while hot, backed off once quiet. */
export function nextGitPollDelay(
  quietTicks: number,
  opts: { pollMs: number; idlePollMs: number; idleAfterTicks: number; hot: boolean },
): number {
  if (opts.hot) return opts.pollMs;
  return quietTicks >= opts.idleAfterTicks
    ? Math.max(opts.pollMs, opts.idlePollMs)
    : opts.pollMs;
}

export function useGitChanges(opts: UseGitChangesOptions = {}): GitChanges {
  const {
    pollMs = GIT_POLL_MS,
    idlePollMs = GIT_IDLE_POLL_MS,
    idleAfterTicks = GIT_IDLE_AFTER_TICKS,
    hot = false,
    cwd = process.cwd(),
    snapshot = snapshotGitChanges,
  } = opts;
  const [changes, setChanges] = useState<GitChanges>(EMPTY_GIT_CHANGES);
  // Serialize the state through a ref + JSON compare so an unchanged poll
  // result does not trigger a re-render (and thus an Ink repaint).
  const lastJson = useRef('');

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Consecutive unchanged snapshots — the idle back-off's only input.
    let quiet = 0;
    const tick = async () => {
      try {
        const snap = await snapshot(cwd);
        if (cancelled) return;
        const json = JSON.stringify(snap);
        if (json !== lastJson.current) {
          lastJson.current = json;
          quiet = 0;
          setChanges(snap);
        } else {
          quiet += 1;
        }
      } catch {
        // Best-effort — keep the previous snapshot, and count it as quiet: a
        // broken `git` (missing binary, lock storm) must not keep us hot.
        quiet += 1;
      }
      if (!cancelled) {
        timer = setTimeout(
          tick,
          nextGitPollDelay(quiet, { pollMs, idlePollMs, idleAfterTicks, hot }),
        );
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
    // `hot` is a dependency on purpose: flipping it (sidebar opened, turn
    // started) restarts the loop — immediate refresh + fast cadence — so the
    // panel never opens onto a stale chip.
  }, [pollMs, idlePollMs, idleAfterTicks, hot, cwd, snapshot]);

  return changes;
}
