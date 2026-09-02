/**
 * workspace/planStore.ts — Durable workspace task store (ADR-0018, slice 3a).
 *
 * Canonical, versioned view of `.zelari/plan.json`, shared by the agent-loop
 * `task_*` tools (src/cli/tools/planTaskTools.ts) and the council stubs
 * (createPlan/createTask/updateTask — src/cli/workspace/stubs.ts).
 *
 * Contract (docs/decisions/0018-workspace-task-store-plan-json.md):
 *  - Envelope v1: root carries `schemaVersion`, `counter`, `tasks`; every
 *    other root field (`phases`, `milestones`, council metadata, …) is
 *    preserved verbatim in pass-through. Unknown fields on a task are kept
 *    unless explicitly overwritten.
 *  - Status: `pending | in_progress | completed | cancelled | blocked`.
 *    Legacy council `done` is normalized to `completed` on read; `task_*`
 *    writes use the v1 vocabulary. Council readers were patched to accept
 *    both (workspaceSummary.ts).
 *  - Ids: `t<N>` sequential via the persisted `counter` — never collides
 *    with council ids (`<phaseId>-<slug>-<N>`).
 *  - Concurrency: same in-process keyed mutex as the council stubs
 *    (`workspaceMutex`, key `<root>:plan`) + atomic tmp+rename write, with a
 *    `plan.json.bak` backup before rewriting an existing file. Cross-process
 *    races (two CLIs on the same cwd) remain best-effort until a lock file
 *    lands (ADR-0018 hardening, out of scope for 3a).
 *
 * @since v1.43.0
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveWorkspaceRoot } from './paths.js';
import { Storage, workspaceMutex } from './storage.js';

export const PLAN_SCHEMA_VERSION = 1;
export const PLAN_MAX_TASKS = 100;
export const PLAN_TITLE_MAX = 200;
export const PLAN_NOTES_MAX = 2000;
export const PLAN_TAG_MAX = 64;

export type PlanTaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'blocked';

export const PLAN_TASK_STATUSES: readonly PlanTaskStatus[] = [
  'pending',
  'in_progress',
  'completed',
  'cancelled',
  'blocked',
] as const;

export type PlanTaskPriority = 'low' | 'medium' | 'high' | 'critical';

/** Machine flags set by workspace governance (t58–t60); human text in notes. */
export type PlanTaskFlag = 'reopened' | 'stale' | 'overlap';

export const PLAN_FILES_MAX = 32;
export const PLAN_FILE_GLOB_MAX = 260;

/**
 * Trim, drop empties, dedupe (first wins) and cap a declared file-glob list.
 * Shared normalizer for `task_*` input and council `fileRefs` copies so both
 * vocabularies land on the same `files` shape (t56 declared-vs-observed).
 */
export function normalizePlanTaskFiles(
  values: readonly (string | undefined)[] | undefined,
): string[] | undefined {
  if (values === undefined) return undefined;
  const out: string[] = [];
  for (const raw of values) {
    const v = typeof raw === 'string' ? raw.trim().slice(0, PLAN_FILE_GLOB_MAX) : '';
    if (!v || out.includes(v) || out.length >= PLAN_FILES_MAX) continue;
    out.push(v);
  }
  return out;
}

export interface PlanTask {
  id: string;
  /** Human-readable title. Council tasks store the same value in `name`. */
  title: string;
  status: PlanTaskStatus;
  priority?: PlanTaskPriority;
  phaseId?: string;
  notes?: string;
  /** Owning member/agent label (free text, informational). */
  agent?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Declared file globs (project-root relative) touched by this task. */
  files?: string[];
  /** ISO timestamp of the FIRST transition to completed; set once, never rewritten. */
  completedAt?: string;
  /** Machine flags ('reopened' | 'stale' | 'overlap'); human detail stays in notes. */
  flags?: PlanTaskFlag[];
  /** Unknown fields (council `description`, `kind`, `tags`, …) pass through. */
  [key: string]: unknown;
}

/** Typed store error — corrupt file never gets overwritten silently. */
export class PlanStoreError extends Error {
  constructor(
    message: string,
    public readonly code: 'PLAN_CORRUPT' | 'PLAN_TOO_MANY_TASKS',
  ) {
    super(message);
    this.name = 'PlanStoreError';
  }
}

/** Handle passed to `withPlanStore` mutators. Mutate, don't reassign. */
export interface PlanStoreHandle {
  /** The `.zelari` workspace dir (artifacts live under `plan-tasks/`). */
  rootDir: string;
  /** Normalized tasks (council `done` → `completed`, `name` → `title`). */
  tasks: PlanTask[];
  /** Persisted `t<N>` counter. Use `nextPlanTaskId` to allocate ids. */
  counter: number;
}

/** Resolved plan.json path for a project root (creates nothing). */
export function planJsonPathFor(projectRoot: string = process.cwd()): string {
  return join(resolveWorkspaceRoot(projectRoot), 'plan.json');
}

interface LoadedHandle extends PlanStoreHandle {
  /** Other root fields (phases, milestones, …) — rewritten verbatim. */
  rootFields: Record<string, unknown>;
}

/**
 * Read-modify-write the plan store under the shared workspace mutex.
 * Corrupt JSON → PlanStoreError('PLAN_CORRUPT') and the file is left intact.
 */
export async function withPlanStore<T>(
  projectRoot: string,
  fn: (store: PlanStoreHandle) => T,
): Promise<T> {
  const rootDir = resolveWorkspaceRoot(projectRoot);
  return workspaceMutex.run(`${rootDir}:plan`, () => {
    const handle = loadHandle(rootDir);
    const out = fn(handle);
    saveHandle(rootDir, handle);
    return out;
  });
}

/** Allocate the next `t<N>` id (increments the persisted counter). */
export function nextPlanTaskId(store: PlanStoreHandle): string {
  const maxExisting = store.tasks.reduce((max, t) => {
    const m = /^t(\d+)$/.exec(t.id);
    return m ? Math.max(max, parseInt(m[1]!, 10)) : max;
  }, 0);
  store.counter = Math.max(store.counter, maxExisting) + 1;
  return `t${store.counter}`;
}

/** Write/refresh the per-task artifact the workspace summary links to. */
export function writePlanTaskArtifact(
  rootDir: string,
  task: PlanTask,
): void {
  const path = join(rootDir, 'plan-tasks', `${task.id}.md`);
  mkdirSync(dirname(path), { recursive: true });
  const meta: Record<string, unknown> = {
    kind: 'task',
    id: task.id,
    name: task.title,
    phaseId: task.phaseId,
    status: task.status,
    priority: task.priority ?? 'medium',
    updatedAt: task.updatedAt,
  };
  const body = [
    `# Task ${task.id}: ${task.title}`,
    '',
    `- Status: **${task.status}**`,
    `- Priority: ${task.priority ?? 'medium'}`,
    task.phaseId ? `- Phase: ${task.phaseId}` : null,
    task.agent ? `- Agent: ${task.agent}` : null,
    '',
    task.notes?.trim() ? task.notes.trim() : '_(no notes)_',
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');
  new Storage().write(path, meta, body);
}

// ── internals ─────────────────────────────────────────────────────────

function loadHandle(rootDir: string): LoadedHandle {
  const jsonPath = join(rootDir, 'plan.json');
  if (!existsSync(jsonPath)) {
    return { rootDir, tasks: [], counter: 0, rootFields: {} };
  }
  let parsed: Record<string, unknown>;
  try {
    const raw = JSON.parse(readFileSync(jsonPath, 'utf8')) as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('root is not a JSON object');
    }
    parsed = raw as Record<string, unknown>;
  } catch {
    throw new PlanStoreError(
      `PLAN_CORRUPT: ${jsonPath} is not valid JSON — refusing to overwrite a ` +
        `possibly hand-edited or crashed write. Fix or remove the file (a ` +
        `.bak may exist), then retry.`,
      'PLAN_CORRUPT',
    );
  }
  const {
    tasks: rawTasks,
    counter,
    schemaVersion: _schemaVersion,
    ...rootFields
  } = parsed;
  const tasks = (Array.isArray(rawTasks) ? rawTasks : [])
    .map(normalizeTask)
    .filter((t) => typeof t.id === 'string' && t.id.length > 0);
  const numericCounter =
    typeof counter === 'number' && Number.isFinite(counter) && counter >= 0
      ? Math.floor(counter)
      : 0;
  return { rootDir, tasks, counter: numericCounter, rootFields };
}

function saveHandle(rootDir: string, handle: LoadedHandle): void {
  if (handle.tasks.length > PLAN_MAX_TASKS) {
    throw new PlanStoreError(
      `PLAN_TOO_MANY_TASKS: plan.json would exceed ${PLAN_MAX_TASKS} tasks ` +
        `(${handle.tasks.length}) — cancel or complete tasks first.`,
      'PLAN_TOO_MANY_TASKS',
    );
  }
  const jsonPath = join(rootDir, 'plan.json');
  mkdirSync(rootDir, { recursive: true });
  if (existsSync(jsonPath)) {
    copyFileSync(jsonPath, `${jsonPath}.bak`);
  }
  const file = {
    ...handle.rootFields,
    schemaVersion: PLAN_SCHEMA_VERSION,
    counter: handle.counter,
    tasks: handle.tasks,
  };
  const tmp = `${jsonPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8');
  renameSync(tmp, jsonPath);
}

/** Normalize a raw task record (council or v1) into the contract shape. */
function normalizeTask(raw: unknown): PlanTask {
  const t = (
    raw !== null && typeof raw === 'object'
      ? { ...(raw as Record<string, unknown>) }
      : {}
  ) as PlanTask;
  if (typeof t.id === 'string') {
    t.id = t.id.trim().slice(0, 64);
  }
  const titleSource =
    firstString(t.title) ??
    firstString(t.name) ??
    firstString(t.description) ??
    '';
  t.title = titleSource.slice(0, PLAN_TITLE_MAX);
  // Council readers (buildPlanSummary) render `name` — keep the alias in
  // sync so t<N> tasks display correctly there too.
  if (t.title && !firstString(t.name)) {
    t.name = t.title;
  }
  t.status = normalizeStatus(t.status);
  if (typeof t.notes === 'string') {
    t.notes = t.notes.slice(0, PLAN_NOTES_MAX);
  }
  if (typeof t.phaseId === 'string') {
    t.phaseId = t.phaseId.slice(0, PLAN_TAG_MAX);
  }
  if (typeof t.agent === 'string') {
    t.agent = t.agent.slice(0, PLAN_TAG_MAX);
  }
  return t;
}

function normalizeStatus(raw: unknown): PlanTaskStatus {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  switch (s) {
    case 'in_progress':
    case 'in-progress':
    case 'doing':
    case 'started':
    case 'active':
      return 'in_progress';
    case 'completed':
    case 'complete':
    case 'done':
    case 'finished':
      return 'completed';
    case 'cancelled':
    case 'canceled':
    case 'closed':
      return 'cancelled';
    case 'blocked':
    case 'on-hold':
    case 'on hold':
      return 'blocked';
    default:
      return 'pending';
  }
}

function firstString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}
