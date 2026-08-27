/**
 * fileOwnership.ts — P2.A: write-scope ownership for the wave scheduler (pure).
 *
 * The executor admits ready nodes up to `maxParallel` and settles one at a
 * time; the parallelism decision between two WRITERS is exactly a file-ownership
 * question — two tentacles writing overlapping scopes concurrently is the
 * corruption that produced duplicate parallel implementations of the same
 * modules. This module owns that decision as a pure function so it can be
 * unit-tested without a graph, a scheduler, or a filesystem:
 *
 *   - `writeScopeOf(node)` — the node's normalized write-scope glob set, or
 *     null when the node never writes. A writer (kind 'general') with NO scope
 *     is a WILDCARD writer: it conservatively conflicts with every other
 *     writer, because an undeclared scope means "anywhere" and not "nowhere".
 *     explore/verify (and the spec/conformance reviewer personas) are
 *     read-only and never conflict; fix edits and merge commits are writers,
 *     as is any kind we do not explicitly know to be read-only.
 *   - `hasWriteOverlap(a, b)` — could both nodes' write scopes cover one
 *     common path? Glob-overlap semantics: identical, disjoint, ancestor
 *     containment (`src/**` vs `src/a/**`), catch-all `**`, and same-path
 *     different-glob all resolve; ambiguity resolves to overlap (honest
 *     conservatism — an unnecessary serialization costs minutes, a missed
 *     overlap corrupts the tree).
 *   - `arbitrateAdmission(candidates, inFlight)` — greedy pass over the
 *     candidates in the caller's admission order: a writer is admitted only if
 *     it overlaps neither an already-admitted writer nor an in-flight writer.
 *     Overlapping writers are DEFERRED, never failed — they stay READY and the
 *     scheduler naturally re-offers them on the next completion, which is the
 *     existing settle-one-at-a-time loop doing the sequencing for free.
 *
 * Glob semantics (deliberately simple, matching policyEngine's `globToRegExp`):
 * `*` and `**` are both "any run of characters, including `/`" — conservative
 * prefix patterns, not full minimatch (`src/*.ts` also covers `src/a/b.ts`,
 * which can only over-serialize, never under-serialize). Every other
 * character is literal. Case folding follows the caller's filesystem: like
 * sandboxPath, win32/darwin fold case (`SRC/**` and `src/**` are the same
 * directory there) — pass `caseInsensitiveFs(process.platform)`.
 *
 * PURE by contract: no fs, no env, no clock, no imports from the executor.
 * Platform-dependent behavior is injected via arguments.
 *
 * @since v0.10.x — Kraken wave scheduler ownership arbitration (P2.A / t25)
 */

/** Structural node shape — `TaskNode` from @zelari/core satisfies this. */
export interface OwnershipNode {
  readonly id: string;
  readonly kind: string;
  readonly scope?: readonly string[];
}

/** Kinds that never mutate the workspace (read-only / read+bash reviewers). */
const READ_ONLY_KINDS: readonly string[] = ['explore', 'verify', 'spec', 'conformance'];

/** Normalized scope meaning "may write anywhere" — conflicts with all writers. */
const WILDCARD: readonly string[] = ['**'];

export interface ArbitrationOptions {
  /**
   * Fold character case before comparing scope globs. Default TRUE — the
   * safe default (over-serializing on a case-sensitive FS is merely slower;
   * under-serializing on a case-insensitive one corrupts). Callers on a
   * known case-sensitive FS pass false to keep legitimate parallelism.
   */
  caseInsensitive?: boolean;
}

/** True on platforms whose default filesystem is case-insensitive (sandboxPath convention). */
export function caseInsensitiveFs(platform: string): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/**
 * Normalize a scope glob for comparison: backslashes → `/`, `./` stripped,
 * duplicate slashes collapsed, trailing slash dropped, lone `.` (whole tree)
 * → `**`. Deliberately mirrors core's `normalizeScopePath` so both layers
 * agree on what the planner emitted.
 */
export function normalizeGlob(p: string): string {
  let s = p.trim().replace(/\\/g, '/');
  if (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  if (s === '.') s = '**';
  return s;
}

/**
 * The write scope a node claims, or null when it never writes.
 *
 * Returns the normalized glob set for writers; a missing/empty scope on a
 * writer normalizes to the wildcard `**` (undeclared scope = "anywhere",
 * and two anywheres must never run concurrently).
 */
export function writeScopeOf(node: OwnershipNode): readonly string[] | null {
  if (READ_ONLY_KINDS.includes(node.kind)) return null;
  const scope = node.scope;
  if (!scope || scope.length === 0) return WILDCARD;
  const globs = scope.map(normalizeGlob).filter((g) => g.length > 0);
  return globs.length > 0 ? globs : WILDCARD;
}

/** Pattern → token list: literal chars stay, consecutive `*`/`**` collapse to one wildcard. */
function tokenize(glob: string): string[] {
  const toks: string[] = [];
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === '*') {
      toks.push('*');
      while (glob[i + 1] === '*') i++;
    } else {
      toks.push(glob[i]);
    }
  }
  return toks;
}

/**
 * Do two token lists match at least one common string? DP over both lists at
 * once: a wildcard on either side may consume zero or more characters (also
 * the other side's next token), literals must agree character by character.
 * Memoized — O(n·m) states for pattern lengths n, m.
 */
function tokenListsOverlap(a: readonly string[], b: readonly string[]): boolean {
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    if (i === a.length && j === b.length) return true;
    const key = i * (b.length + 1) + j;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let r: boolean;
    if (i < a.length && a[i] === '*') {
      r = go(i + 1, j) || (j < b.length && go(i, j + 1));
    } else if (j < b.length && b[j] === '*') {
      r = go(i, j + 1) || (i < a.length && go(i + 1, j));
    } else if (i === a.length || j === b.length) {
      r = false; // one side exhausted, the other still owes a literal
    } else {
      r = a[i] === b[j] && go(i + 1, j + 1);
    }
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

/**
 * Could the two scope globs cover one common path? Identical patterns and
 * catch-alls short-circuit; everything else goes through the overlap DP.
 */
export function globsOverlap(a: string, b: string, caseInsensitive = true): boolean {
  const ga = normalizeGlob(caseInsensitive ? a.toLowerCase() : a);
  const gb = normalizeGlob(caseInsensitive ? b.toLowerCase() : b);
  if (ga === gb) return true;
  if (ga === '' || gb === '' || ga === '**' || gb === '**') return true;
  // A glob-less entry names a DIRECTORY — it claims everything under it (core's
  // pathsOverlap ancestor rule), so it overlaps as `dir/**`.
  const ta = tokenize(ga.includes('*') ? ga : `${ga}/**`);
  const tb = tokenize(gb.includes('*') ? gb : `${gb}/**`);
  return tokenListsOverlap(ta, tb);
}

/**
 * Could both nodes write the same file? False when either is read-only;
 * otherwise any glob pair from their write scopes overlapping decides.
 */
export function hasWriteOverlap(
  nodeA: OwnershipNode,
  nodeB: OwnershipNode,
  opts: ArbitrationOptions = {},
): boolean {
  const scopeA = writeScopeOf(nodeA);
  if (!scopeA) return false;
  const scopeB = writeScopeOf(nodeB);
  if (!scopeB) return false;
  const fold = opts.caseInsensitive ?? true;
  return scopeA.some((x) => scopeB.some((y) => globsOverlap(x, y, fold)));
}

export interface AdmissionResult<T extends OwnershipNode> {
  /** Cleared to start this round, in the caller's admission order. */
  admitted: T[];
  /** Writers held back by an overlap — still READY, re-offered next round. */
  deferred: T[];
}

/**
 * Greedy admission arbitration over the caller's candidate list.
 *
 * Read-only nodes are always admissible (the caller's own dep/capacity checks
 * still apply — this module only decides file ownership). A writer is admitted
 * unless it overlaps an already-admitted writer this round or an in-flight
 * writer; overlapping writers are deferred, never failed, so admission order
 * is stable and the deferred node is retried on the very next completion.
 */
export function arbitrateAdmission<T extends OwnershipNode>(
  candidates: readonly T[],
  inFlight: readonly T[] = [],
  opts: ArbitrationOptions = {},
): AdmissionResult<T> {
  const admitted: T[] = [];
  const deferred: T[] = [];
  for (const node of candidates) {
    if (writeScopeOf(node) === null) {
      admitted.push(node);
      continue;
    }
    const clash =
      admitted.some((a) => hasWriteOverlap(a, node, opts)) ||
      inFlight.some((f) => hasWriteOverlap(f, node, opts));
    if (clash) deferred.push(node);
    else admitted.push(node);
  }
  return { admitted, deferred };
}
