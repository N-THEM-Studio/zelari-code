/**
 * taskStaleness — session-start staleness sweep (t59, plan P1.5).
 *
 * At session bootstrap (same seam as the t58 TaskTouchGuard — the parent
 * tool-registry factory, fire-and-forget) every `completed` task that
 * declares `files` and has a `completedAt` OLDER than the stale threshold
 * (default 24h, env `ZELARI_TASK_STALE_HOURS`) is checked against
 * `gitLogSince`: if commits landed after `completedAt` touching the
 * declared pathspecs, the task is flagged:
 *  - flags.push('stale') + appendNote on the plan task (withPlanStore);
 *  - one `task_stale` radio event (agent `task-guard`).
 *
 * Idempotent: tasks already flagged 'stale' are skipped (clearing the flag
 * re-enables the signal). Silent skip when the root is not a git repo.
 *
 * Advisory-only per ADR 0023: unknown never blocks anything — the sweep is
 * total fail-open and must never break a session start.
 *
 * @since v2.26.0 (t59)
 */

import { existsSync } from 'node:fs';
import { appendKrakenRadio } from '../tools/krakenRadio.js';
import { gitLogSince, isGitRepo } from '../gitOps.js';
import { PLAN_NOTES_MAX, planJsonPathFor, withPlanStore } from './planStore.js';

export const TASK_STALE_HOURS_DEFAULT = 24;

/** Resolve the stale threshold from ZELARI_TASK_STALE_HOURS (default 24h). */
export function taskStaleHours(): number {
  const raw = process.env.ZELARI_TASK_STALE_HOURS;
  if (raw === undefined || raw.trim() === '') return TASK_STALE_HOURS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return TASK_STALE_HOURS_DEFAULT;
  return n;
}

export interface StaleTaskReport {
  taskId: string;
  /** Commit subject lines that touched declared files after completedAt. */
  commits: string[];
}

export interface TaskStalenessOptions {
  /** Project root (plan.json lives at `<root>/.zelari/plan.json`). */
  projectRoot: string;
  /** Radio session id for `task_stale` events. */
  sessionId: string;
  /** Injectable clock (tests pin the threshold ordering). */
  now?: () => number;
  /** Override the env threshold (tests). */
  hoursOverride?: number;
}

/**
 * Run the staleness sweep. Returns reports for newly-flagged tasks.
 * Never throws; on any failure returns what it has (or empty).
 */
export async function runTaskStalenessCheck(
  opts: TaskStalenessOptions,
): Promise<StaleTaskReport[]> {
  const root = opts.projectRoot;
  const nowMs = (opts.now ?? Date.now)();
  try {
    if (!existsSync(planJsonPathFor(root))) return [];
    if (!(await isGitRepo(root))) return [];
    const hours = opts.hoursOverride ?? taskStaleHours();
    const cutoff = nowMs - hours * 3_600_000;

    const tasks = await withPlanStore(root, (store) => store.tasks);
    const reports: StaleTaskReport[] = [];
    for (const task of tasks) {
      if (task.status !== 'completed' || !task.files?.length || !task.completedAt) continue;
      if (Array.isArray(task.flags) && task.flags.includes('stale')) continue;
      const doneAt = Date.parse(task.completedAt);
      if (!Number.isFinite(doneAt) || doneAt >= cutoff) continue;
      const commits = await gitLogSince(root, task.completedAt, task.files);
      if (commits.length === 0) continue;
      reports.push({ taskId: task.id, commits });
      appendKrakenRadio(root, opts.sessionId, {
        kind: 'task_stale',
        agent: 'task-guard',
        description: `completed task ${task.id} declared files changed by later commits`,
        contestedFile: task.files[0],
        ok: true,
        detail: `${task.title} — ${commits.length} later commit(s), newest: ${commits[0]}`,
      });
    }
    if (reports.length > 0) {
      try {
        await withPlanStore(root, (store) => {
          const stamp = new Date(nowMs).toISOString();
          for (const report of reports) {
            const live = store.tasks.find((t) => t.id === report.taskId);
            if (!live) continue;
            const flags = Array.isArray(live.flags) ? [...live.flags] : [];
            if (!flags.includes('stale')) live.flags = [...flags, 'stale'];
            const note = `[task-guard ${stamp}] stale: ${report.commits.length} commit(s) landed after completion on declared files`;
            live.notes = `${live.notes ? `${live.notes}\n` : ''}${note}`.slice(0, PLAN_NOTES_MAX);
          }
        });
      } catch {
        // flag/note are best-effort; the radio events already went out
      }
    }
    return reports;
  } catch {
    // fail-open (missing/corrupt plan.json, git failures, radio io, …)
    return [];
  }
}
