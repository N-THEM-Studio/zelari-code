/**
 * taskOverlap — advisory overlap guard (t60, plan P1.5).
 *
 * Pure helpers that detect declared-files overlap between a candidate task
 * and OTHER `in_progress` tasks in .zelari/plan.json. The guard is
 * advisory-only and NEVER blocks a call: writer serialization stays the
 * lead's policy — this module just strengthens the signal (one radio event
 * `task_overlap` + an advisory note + the `overlap` flag on the task).
 *
 * Glob vocabulary matches taskTouchGuard (t58): exact root-relative path,
 * directory subtree (dir followed by double-star), extension suffix
 * (star-dot-ext at any depth). Excluded subtrees (.zelari, node_modules,
 * dist, build) never overlap — plan.json churn is by design.
 *
 * @since v2.26.0 (t60)
 */

import { matchTaskFiles } from './taskTouchGuard.js';
import type { PlanTask } from './planStore.js';

const EXCLUDED_DIR_PREFIXES = ['.zelari/', 'node_modules/', 'dist/', 'build/'];

function normalizePattern(raw: string): string {
  return raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\*\*\//, '');
}

/** Excluded subtrees and empty patterns never participate in overlap. */
function isActivePattern(raw: string): boolean {
  const n = normalizePattern(raw);
  if (!n) return false;
  return !EXCLUDED_DIR_PREFIXES.some((p) => n === p.slice(0, -1) || n.startsWith(p));
}

/**
 * First candidate glob that intersects any of `others` (exact, subtree or
 * suffix semantics, checked in both directions), or null when disjoint.
 */
export function globsIntersect(
  candidate: readonly string[],
  others: readonly string[],
): string | null {
  const cands = candidate.filter(isActivePattern);
  const other = others.filter(isActivePattern);
  for (const c of cands) {
    for (const o of other) {
      const nc = normalizePattern(c);
      const no = normalizePattern(o);
      if (nc === no) return c;
      if (matchTaskFiles([c], no)) return c;
      if (matchTaskFiles([o], nc)) return c;
    }
  }
  return null;
}

/** An in_progress task whose declared files intersect the candidate's. */
export interface OverlapHit {
  /** The OTHER in_progress task (store order, not the candidate). */
  task: PlanTask;
  /** Shared glob/path, expressed in the candidate's vocabulary. */
  contested: string;
}

/**
 * All in_progress tasks (excluding `excludeId`) whose declared files
 * intersect `candidateFiles`. Deterministic: store order, first contested
 * glob per pair. Completed / cancelled / pending tasks never count.
 */
export function findOverlappingTasks(
  candidateFiles: readonly string[] | undefined,
  tasks: readonly PlanTask[],
  excludeId?: string,
): OverlapHit[] {
  if (!candidateFiles || candidateFiles.length === 0) return [];
  const hits: OverlapHit[] = [];
  for (const t of tasks) {
    if (t.id === excludeId) continue;
    if (t.status !== 'in_progress') continue;
    if (!t.files || t.files.length === 0) continue;
    const contested = globsIntersect(candidateFiles, t.files);
    if (contested) hits.push({ task: t, contested });
  }
  return hits;
}

/** Advisory note line appended to the flagged task (kept short, t60). */
export function overlapNoteLine(hits: readonly OverlapHit[]): string {
  const pairs = hits.map((h) => `${h.task.id} (${h.contested})`).join(', ');
  return (
    `Overlap advisory (t60): files intersect in_progress task(s) ${pairs}. ` +
    'Advisory only — writer serialization stays the lead policy.'
  );
}
