/**
 * taskTouchGuard — declared-vs-observed hygiene guard (t58, plan P1.5).
 *
 * Watches post-result write events (t57 ToolRegistry post-result seam) and
 * flags `completed` tasks whose declared `files` globs are touched by a
 * LATER session (cross-session rule: sessionStartedAt > completedAt, so the
 * session that completes a task never auto-flags itself).
 *
 * On a match (best-effort, total fail-open — this code must never break a
 * tool call):
 *  - one `task_reopened` radio event per task per session
 *    (`.zelari/radio/<sessionId>.jsonl`, agent `task-guard`);
 *  - flags.push('reopened') + an appendNote on the plan task, through
 *    withPlanStore so the shared workspace mutex keeps it consistent with
 *    concurrent `task_update` calls.
 *
 * Supported glob vocabulary (documented, minimal — no new deps):
 *  - exact root-relative path:      src/cli/foo.ts
 *  - directory subtree (recursive): src followed by double-star
 *  - extension suffix (any depth):  *.ts  (leading double-star prefix also ok)
 *
 * Excluded, never matched: .zelari, node_modules, dist, build subtrees
 * (plan.json itself changes constantly by design).
 *
 * @since v2.26.0 (t58)
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { appendKrakenRadio } from '../tools/krakenRadio.js';
import { PLAN_NOTES_MAX, planJsonPathFor, withPlanStore } from './planStore.js';
import type { PlanTask } from './planStore.js';

/** Native mutating tools (catalog names) + MCP filesystem variants. */
const NATIVE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit',
  'edit_file',
  'apply_diff',
]);
const MCP_FS_WRITE_RE = /^mcp_filesystem_(write_file|edit_file|move_file|create_directory)$/;

const EXCLUDED_DIR_PREFIXES = ['.zelari/', 'node_modules/', 'dist/', 'build/'];

/** Structural listener event (t57 ToolResultEvent shape — kept import-free). */
export interface TaskTouchEvent {
  toolName: string;
  toolInput: unknown;
  ok: boolean;
}

/** Listener returned by createTaskTouchGuard; `drain` awaits pending work (tests). */
export interface TaskTouchListener {
  (event: TaskTouchEvent): void;
  /** Resolves when every queued write inspection settled (never rejects). */
  drain(): Promise<void>;
}

export function isMutatingToolName(name: string): boolean {
  return NATIVE_WRITE_TOOLS.has(name) || MCP_FS_WRITE_RE.test(name);
}

/**
 * Normalize a tool-supplied path to a root-relative POSIX path.
 * Absolute paths outside `projectRoot` (and Windows drive crossings) → null.
 */
export function toPosixRel(projectRoot: string, p: string): string | null {
  const raw = p.trim().replace(/\\/g, '/');
  if (raw.startsWith('/') || /^[a-zA-Z]:\//.test(raw)) {
    let rel: string;
    try {
      rel = path.relative(projectRoot, p);
    } catch {
      return null;
    }
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.replace(/\\/g, '/');
  }
  return raw.replace(/^\.\//, '');
}

/** Pull the mutated path out of a mutating tool's args (MCP uses `file_path`). */
export function extractWriteTarget(toolName: string, toolInput: unknown): string | null {
  if (!isMutatingToolName(toolName)) return null;
  const args = (toolInput ?? {}) as Record<string, unknown>;
  for (const key of ['path', 'file_path', 'source', 'destination']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function normalizePattern(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\*\*\//, '');
}

/**
 * Match a root-relative path against declared task globs.
 * Excluded dirs (.zelari, node_modules, dist, build) never match.
 */
export function matchTaskFiles(patterns: readonly string[], relPath: string): boolean {
  if (EXCLUDED_DIR_PREFIXES.some((p) => relPath.startsWith(p))) return false;
  for (const raw of patterns) {
    const pat = normalizePattern(raw);
    if (!pat) continue;
    if (pat === relPath) return true;
    if (pat.endsWith('/**')) {
      if (relPath.startsWith(pat.slice(0, -2))) return true;
    } else if (pat.includes('*')) {
      const star = pat.indexOf('*');
      const suffix = pat.slice(star + 1);
      if (suffix && !suffix.includes('*') && relPath.endsWith(suffix)) return true;
    }
  }
  return false;
}

export interface TaskTouchGuardOptions {
  /** Project root (plan.json lives at `<root>/.zelari/plan.json`). */
  projectRoot: string;
  /** Radio session id for `task_reopened` events. */
  sessionId: string;
  /** Injectable clock (tests pin cross-session ordering). */
  now?: () => number;
}

/**
 * Build the t57 listener. Every inspection is chained onto an internal
 * promise queue so tests (and shutdown paths) can drain() it; the listener
 * itself stays synchronous and never throws (total fail-open).
 */
export function createTaskTouchGuard(opts: TaskTouchGuardOptions): TaskTouchListener {
  const root = opts.projectRoot;
  const sessionId = opts.sessionId;
  const sessionStartedAt = (opts.now ?? Date.now)();
  const flagged = new Set<string>();
  let chain: Promise<void> = Promise.resolve();

  const listener = (event: TaskTouchEvent): void => {
    try {
      if (!event.ok) return;
      const target = extractWriteTarget(event.toolName, event.toolInput);
      if (!target) return;
      const rel = toPosixRel(root, target);
      if (!rel) return;
      chain = chain.then(() => inspectWrite(rel)).catch(() => undefined);
    } catch {
      // fail-open: the guard must never break a tool result
    }
  };
  listener.drain = () => chain;
  return listener;

  async function inspectWrite(rel: string): Promise<void> {
    try {
      const planPath = planJsonPathFor(root);
      if (!existsSync(planPath)) return;
      const tasks: PlanTask[] = await withPlanStore(root, (store) => store.tasks);
      for (const task of tasks) {
        if (task.status !== 'completed' || !task.files?.length || !task.completedAt) continue;
        if (flagged.has(task.id)) continue;
        const doneAt = Date.parse(task.completedAt);
        if (!Number.isFinite(doneAt) || sessionStartedAt <= doneAt) continue;
        if (!matchTaskFiles(task.files, rel)) continue;
        flagged.add(task.id);
        appendKrakenRadio(root, sessionId, {
          kind: 'task_reopened',
          agent: 'task-guard',
          description: `completed task ${task.id} file touched after completion`,
          contestedFile: rel,
          ok: true,
          detail: `${task.title} — ${rel}`,
        });
        try {
          await withPlanStore(root, (store) => {
            const live = store.tasks.find((t) => t.id === task.id);
            if (!live) return;
            const flags = Array.isArray(live.flags) ? [...live.flags] : [];
            if (!flags.includes('reopened')) live.flags = [...flags, 'reopened'];
            const stamp = new Date(sessionStartedAt).toISOString();
            const note = `[task-guard ${stamp}] ${rel} modified after completion (reopened)`;
            live.notes = `${live.notes ? `${live.notes}\n` : ''}${note}`.slice(0, PLAN_NOTES_MAX);
          });
        } catch {
          // flag/note are best-effort; the radio event already went out
        }
      }
    } catch {
      // fail-open (missing/corrupt plan.json, radio io, …)
    }
  }
}
