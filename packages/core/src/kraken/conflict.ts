/**
 * Kraken graph engine — scope-overlap detection & parallelism policy (pure).
 *
 * Decides whether two graph nodes may run concurrently. Read-only kinds
 * (explore/verify) are always parallel-safe; writers (general/fix) may run in
 * parallel only when their path scopes are provably disjoint. Conservative by
 * design: any ambiguity resolves to "not parallel". No CLI dependencies.
 *
 * @since v0.10.x — Kraken graph engine (F1)
 */

import type { TaskNode, TaskNodeKind } from './graph.js';

/** Kinds that never mutate the workspace (read-only / read+bash). */
const READ_ONLY_KINDS: readonly TaskNodeKind[] = ['explore', 'verify'];

/** Kinds that mutate the workspace and therefore need disjoint scopes. */
const WRITER_KINDS: readonly TaskNodeKind[] = ['general', 'fix'];

/** Normalize a path/glob for comparison: forward slashes, no `./` or trailing `/`. */
export function normalizeScopePath(p: string): string {
  let s = p.trim().replace(/\\/g, '/');
  // Strip a leading `./`.
  if (s.startsWith('./')) s = s.slice(2);
  // Collapse duplicate slashes.
  s = s.replace(/\/{2,}/g, '/');
  // Strip trailing slash (but keep a bare `/` as-is → becomes '').
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  // A lone `.` means "the current dir / whole tree" → normalize to root.
  if (s === '.') s = '';
  return s;
}

/** Split a normalized path into segments (drops empty segments). */
function segments(p: string): string[] {
  return normalizeScopePath(p)
    .split('/')
    .filter((s) => s.length > 0);
}

/** Does a segment contain a glob wildcard? */
function isGlobSegment(seg: string): boolean {
  return seg.includes('*') || seg.includes('?') || seg.includes('[');
}

/** Escape regex-special chars in a literal string. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match a single path segment against another, honoring glob wildcards.
 * `*` matches any run within the segment, `?` matches one char, `[...]` is a
 * char class. If both segments are globs we conservatively assume they CAN
 * match the same name (→ potential overlap).
 */
function segmentMatches(a: string, b: string): boolean {
  if (a === b) return true;
  if (a === '**' || b === '**') return true;
  const aGlob = isGlobSegment(a);
  const bGlob = isGlobSegment(b);
  if (aGlob && bGlob) return true; // ambiguous → assume overlap (conservative)
  if (aGlob) return globSegmentToRegex(a).test(b);
  if (bGlob) return globSegmentToRegex(b).test(a);
  return false; // two distinct literals
}

/** Compile a single glob segment to an anchored RegExp (`*`→`.*`, `?`→`.`). */
function globSegmentToRegex(seg: string): RegExp {
  let re = '';
  for (const ch of seg) {
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += escapeRegex(ch);
  }
  return new RegExp(`^${re}$`);
}

/**
 * Decide whether two scope paths could match a common file (i.e. their allowed
 * sets are NOT provably disjoint). Comparison is segment-wise so that
 * `src/auth` and `src/authz` do NOT overlap, while `src/auth` and
 * `src/auth/jwt.ts` DO (ancestor/descendant). A `**` segment overlaps anything
 * at or below its position.
 *
 * Conservative: returns true (overlap) on any ambiguity.
 */
export function pathsOverlap(a: string, b: string): boolean {
  const segA = segments(a);
  const segB = segments(b);

  // Two empty/root scopes both mean "the whole tree" → overlap.
  if (segA.length === 0 && segB.length === 0) return true;

  const len = Math.min(segA.length, segB.length);
  for (let i = 0; i < len; i++) {
    const sa = segA[i];
    const sb = segB[i];
    if (sa === '**' || sb === '**') return true; // globstar swallows the rest
    if (!segmentMatches(sa, sb)) return false; // diverged → disjoint
  }

  // All compared segments matched. If one path is an ancestor of the other
  // (or they are equal), their sets overlap.
  return true;
}

/**
 * True when two scope allowlists are provably disjoint (no pair overlaps).
 * Empty/absent scopes are treated as "whole tree" → NOT disjoint.
 */
export function disjointScopeSets(
  scopeA: string[] | undefined,
  scopeB: string[] | undefined,
): boolean {
  if (!scopeA || scopeA.length === 0) return false;
  if (!scopeB || scopeB.length === 0) return false;
  for (const a of scopeA) {
    for (const b of scopeB) {
      if (pathsOverlap(a, b)) return false;
    }
  }
  return true;
}

/**
 * May two nodes execute concurrently?
 *  - read-only kinds (explore/verify) are always parallel-safe;
 *  - a `merge` node is never parallel (it must serialize on its branch);
 *  - two writers (general/fix) run in parallel only if both declare scopes and
 *    those scopes are provably disjoint;
 *  - any missing scope on a writer → conservative "not parallel".
 */
export function canRunParallel(a: TaskNode, b: TaskNode): boolean {
  if (a.kind === 'merge' || b.kind === 'merge') return false;
  if (READ_ONLY_KINDS.includes(a.kind) || READ_ONLY_KINDS.includes(b.kind)) {
    return true;
  }
  // Both are writers (general/fix): require provably disjoint scopes.
  if (WRITER_KINDS.includes(a.kind) && WRITER_KINDS.includes(b.kind)) {
    return disjointScopeSets(a.scope, b.scope);
  }
  // Unknown kind combination → conservative.
  return false;
}

/**
 * From a set of candidate nodes, pick the largest prefix (in input order) that
 * can ALL run concurrently with each other. Used by the executor to form a
 * parallel wave. The first node is always included.
 */
export function selectParallelWave(candidates: TaskNode[]): TaskNode[] {
  const wave: TaskNode[] = [];
  for (const node of candidates) {
    if (wave.every((w) => canRunParallel(w, node))) wave.push(node);
  }
  return wave;
}
