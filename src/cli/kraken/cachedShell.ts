/**
 * cachedShell — Int2b / plan v2 §6.2: in-process result cache for the
 * verification-gate commands (typecheck / test / build / contract `Verify:`).
 *
 * Why: one strict turn evaluates the SAME deterministic commands up to three
 * times — the first gate, the post-repair gate (`runOneTurn.ts`), and the
 * end-of-mission gate. Those commands are minutes each and a repair often
 * lands no delta at all, so the second run buys the same exit code and the
 * same stdout digest at full price.
 *
 * What does NOT change: the verdict. A hit is served ONLY when the key proves
 * the observation must be identical — same command line, same relative cwd,
 * same timeout, and an UNCHANGED working tree (`HEAD` + a digest of
 * `git status --porcelain` over tracked AND untracked files). A cached FAIL
 * stays FAIL, and the stdout digest the F3 evidence anchoring depends on is
 * byte-identical by construction (only provenance is annotated: `cached:
 * true`, which the engine surfaces in `detail` and in `verification.evidence`).
 *
 * Fail-open everywhere: not a git worktree, no git binary, no commit yet,
 * unreadable status, or a git call past its 10 s cap → no tree token → no key
 * → the command executes exactly as before.
 *
 * Kill-switch: `ZELARI_VERIFY_CACHE=0|off|false` (default ON) makes
 * `wrapWithVerifyCache` an IDENTITY function — no wrapper, no git calls.
 *
 * State: the LRU is MODULE-level on purpose. Every gate site builds its own
 * decorator, but they all read/write the same map, so the post-repair and
 * end-of-mission evaluations reuse what the first one observed — that is the
 * whole point of Int2b (no shell plumbing through the bridge needed).
 *
 * Concurrency: the gate is sequential today; two identical commands in flight
 * at the same time can both miss and both execute (no in-flight dedup). That
 * is acceptable and honest — we never serve a result that was not observed.
 *
 * @since v2.38.0 (Int2b)
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { ShellExecOptions, ShellProvider, ShellResult } from '@zelari/core/runtime';

const execFileAsync = promisify(execFile);

type Env = Record<string, string | undefined>;

/** LRU bound (plan §6.2): 32 command results, memory-only, no persistence. */
const MAX_ENTRIES = 32;

/** Freshness window of one tree token inside a single decorator instance. */
const TREE_TTL_MS = 5_000;

/** `git status` can be large on dirty repos; past this it throws → fail-open. */
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

/** A hung git (network mount, index lock) must never stall the gate. */
const GIT_TIMEOUT_MS = 10_000;

/**
 * Module-level LRU (insertion order = recency, Map semantics): a hit is
 * re-inserted, an overflow drops the oldest key. Shared by every decorator
 * instance built in this process — see the header.
 */
const cache = new Map<string, ShellResult>();

/** Test-only: drop every cached entry so suites stay independent. */
export function __resetVerifyCacheForTests(): void {
  cache.clear();
}

/**
 * Kill-switch, mirroring the `ZELARI_VERIFY_PACK` convention (default ON,
 * `0|off|false` opts out).
 */
export function verifyCacheEnabled(env: Env = process.env): boolean {
  const v = env.ZELARI_VERIFY_CACHE?.toLowerCase();
  if (v === '0' || v === 'off' || v === 'false') return false;
  return true;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * `'HEAD:<rev>|<sha256(porcelain)>'`, or null when the root is not a usable
 * git worktree (no git binary, not a repo, unborn HEAD, unreadable status).
 * `--untracked-files=all` is deliberate: the default porcelain collapses an
 * untracked DIRECTORY into a single entry, so a new file inside it would not
 * move the digest.
 */
async function readTreeState(root: string): Promise<string | null> {
  try {
    const opts = { maxBuffer: GIT_MAX_BUFFER, timeout: GIT_TIMEOUT_MS, windowsHide: true } as const;
    const [head, status] = await Promise.all([
      execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'], opts),
      execFileAsync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], opts),
    ]);
    return `HEAD:${String(head.stdout).trim()}|${sha256(String(status.stdout))}`;
  } catch {
    return null;
  }
}

export interface VerifyCacheOptions {
  /** Root the tree token is taken from. Defaults to `process.cwd()`. */
  root?: string;
  /** Env source (tests inject a snapshot); defaults to `process.env`. */
  env?: Env;
}

class CachedShellProvider implements ShellProvider {
  private readonly root: string;

  /**
   * Tree token memo, PER INSTANCE (5 s TTL). Deliberately not module-level: a
   * stale token would keep matching the pre-write key for up to the TTL and
   * serve the PRE-repair result after the repair wrote files — a false PASS
   * window on the gate. Every evaluation builds its own decorator, so a write
   * made between evaluations is always observed; the memo only avoids
   * re-running git for the sibling criteria of the SAME evaluation.
   */
  private treeMemo?: { at: number; value: string | null };

  constructor(
    private readonly inner: ShellProvider,
    options: VerifyCacheOptions = {},
  ) {
    this.root = options.root ?? process.cwd();
  }

  private async treeState(): Promise<string | null> {
    const now = Date.now();
    if (this.treeMemo && now - this.treeMemo.at < TREE_TTL_MS) return this.treeMemo.value;
    const value = await readTreeState(this.root);
    this.treeMemo = { at: now, value };
    return value;
  }

  async exec(command: string, options: ShellExecOptions = {}): Promise<ShellResult> {
    const tree = await this.treeState();
    // Unprovable tree → no key → execute exactly as an undecorated shell.
    if (tree === null) return await this.inner.exec(command, options);

    const key = sha256(
      JSON.stringify({
        command,
        cwd: options.cwd ?? '',
        timeoutMs: options.timeoutMs ?? null,
        tree,
        // Additive safety field: two evaluation roots in ONE process must
        // never collide on the same relative cwd.
        root: this.root,
      }),
    );

    const started = Date.now();
    const hit = cache.get(key);
    if (hit !== undefined) {
      cache.delete(key); // refresh recency
      cache.set(key, hit);
      // Copy on the way out: callers (and tests) must not mutate the entry.
      return { ...hit, cached: true, durationMs: Date.now() - started };
    }

    const result = await this.inner.exec(command, options);
    // Timeouts and signal/abort kills are NOT deterministic observations (the
    // engine maps them to `unknown`) — never served from, never stored in.
    if (!result.timedOut && result.exitCode !== null) {
      cache.set(key, { ...result });
      if (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
    }
    return result;
  }
}

/**
 * Decorate `shell` with the shared verify cache. Identity when the kill-switch
 * is off, so callers can wrap unconditionally.
 */
export function wrapWithVerifyCache(
  shell: ShellProvider,
  options: VerifyCacheOptions = {},
): ShellProvider {
  const env = options.env ?? process.env;
  if (!verifyCacheEnabled(env)) return shell;
  return new CachedShellProvider(shell, options);
}
