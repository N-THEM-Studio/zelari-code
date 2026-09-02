/**
 * tools/planTaskTools.ts — Durable workspace plan-task tools (ADR-0018, 3a).
 *
 * `task_create` / `task_update` / `task_list` operate on the canonical
 * `.zelari/plan.json` store (src/cli/workspace/planStore.ts) shared with the
 * council stubs. Distinct from `todo_write`/`todo_read` (session-scoped,
 * volatile): these tasks are multi-session durable and visible to the
 * Desktop Live Tasks panel (M3).
 *
 * @since v1.43.0
 */
import { z } from 'zod';
import {
  typedOk,
  typedErr,
  type ToolDefinition,
} from '@zelari/core/harness/tools/toolTypes';
import type { BrainTaskPayload } from '@zelari/core/events';
import {
  withPlanStore,
  nextPlanTaskId,
  writePlanTaskArtifact,
  PlanStoreError,
  PLAN_MAX_TASKS,
  PLAN_NOTES_MAX,
  PLAN_TITLE_MAX,
  normalizePlanTaskFiles,
  type PlanTask,
  type PlanTaskPriority,
  type PlanTaskStatus,
} from '../workspace/planStore.js';
import { appendKrakenRadio } from './krakenRadio.js';
import {
  findOverlappingTasks,
  overlapNoteLine,
  type OverlapHit,
} from '../workspace/taskOverlap.js';

const StatusSchema = z
  .enum(['pending', 'in_progress', 'completed', 'cancelled', 'blocked'])
  .describe(
    'blocked exists only here (session todos have no blocked); no rigid FSM — corrections like completed → in_progress are allowed',
  );

const PrioritySchema = z.enum(['low', 'medium', 'high', 'critical']);

const FilesSchema = z
  .array(z.string().min(1).max(260))
  .max(32)
  .describe('File globs relative to the project root touched by this task');

const CreateSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(PLAN_TITLE_MAX)
    .describe('Short task description'),
  priority: PrioritySchema.optional().describe('Default medium'),
  phaseId: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Existing plan phase id (see .zelari/plan.json phases)'),
  notes: z
    .string()
    .max(PLAN_NOTES_MAX)
    .optional()
    .describe('Optional context/acceptance notes'),
  files: FilesSchema.optional(),
  fileRefs: FilesSchema.optional().describe('Alias of files (council vocabulary)'),
});

const UpdateSchema = z
  .object({
    id: z.string().min(1).max(64).describe('Task id from task_create/task_list'),
    status: StatusSchema.optional(),
    title: z.string().min(1).max(PLAN_TITLE_MAX).optional(),
    priority: PrioritySchema.optional(),
    phaseId: z.string().min(1).max(64).optional(),
    notes: z.string().max(PLAN_NOTES_MAX).optional(),
    files: FilesSchema.optional().describe('Replace the declared file globs'),
    fileRefs: FilesSchema.optional().describe('Alias of files (council vocabulary)'),
    appendNote: z
      .string()
      .max(PLAN_NOTES_MAX)
      .optional()
      .describe('Append to existing notes (kept within the size cap)'),
  })
  .describe('At least one field besides id must be present');

const ListSchema = z.object({
  status: StatusSchema.optional().describe('Filter by status'),
  phaseId: z.string().min(1).max(64).optional().describe('Filter by phase'),
});

function taskSummaryLine(t: PlanTask): string {
  return `- ${t.id}: ${t.title} (${t.status}${t.priority ? `, ${t.priority}` : ''})`;
}

/**
 * Domain event emitted by the task_* tools right after a durable write or
 * read (ADR-0018 slice 3b). The headless NDJSON sink upgrades it to a
 * first-class BrainEvent, so frontends (Desktop Live Tasks) never parse
 * tool arguments.
 */
export type PlanTaskEvent =
  | { type: 'task_update'; source: 'workspace_plan'; task: BrainTaskPayload }
  | { type: 'task_snapshot'; source: 'workspace_plan'; tasks: BrainTaskPayload[] };

/** Consumer of {@link PlanTaskEvent}s; failures are isolated by the tools. */
export type PlanTaskEventSink = (event: PlanTaskEvent) => void;

function toTaskPayload(t: PlanTask): BrainTaskPayload {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    phaseId: t.phaseId,
    priority: t.priority,
  };
}

function safeEmit(sink: PlanTaskEventSink | undefined, event: PlanTaskEvent): void {
  if (!sink) return;
  try {
    sink(event);
  } catch {
    // A failing sink must never break the tool result.
  }
}

/** Build the three plan-task tools bound to a project root. */
// Widened to a homogeneous array so callers can map/wrap without fighting
// the input/output unions of the individual tool definitions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createPlanTaskTools(opts: {
  projectRoot: string;
  /** Optional first-class task event sink (ADR-0018 3b). */
  onTaskEvent?: PlanTaskEventSink;
  /** Radio session id for overlap advisories (t60); sanitized by krakenRadio. */
  sessionId?: string;
}): ToolDefinition<any, any>[] {
  const projectRoot = opts.projectRoot;
  const onTaskEvent = opts.onTaskEvent;
  const radioSession = opts.sessionId ?? 'plan-tasks';

  const taskCreate: ToolDefinition<
    z.infer<typeof CreateSchema>,
    { id: string; task: PlanTask }
  > = {
    name: 'task_create',
    description:
      'Create a durable workspace task in .zelari/plan.json (multi-session, shared ' +
      'with the Desktop Live Tasks panel). Use for project work that must survive ' +
      'this session. For volatile per-session tracking use todo_write instead. ' +
      'Returns the assigned id (t<N>).',
    permissions: ['write'],
    timeoutMs: 5_000,
    inputSchema: CreateSchema,
    execute: async (input) => {
      try {
        const res = await withPlanStore(projectRoot, (store) => {
          if (store.tasks.length >= PLAN_MAX_TASKS) {
            return typedErr(
              `PLAN_TOO_MANY_TASKS: plan.json already holds ${store.tasks.length} tasks (max ${PLAN_MAX_TASKS}).`,
            );
          }
          const now = new Date().toISOString();
          const id = nextPlanTaskId(store);
          const task: PlanTask = {
            id,
            title: input.title.trim().slice(0, PLAN_TITLE_MAX),
            // council readers (buildPlanSummary) render `name` — keep the
            // alias in sync from creation, not just on reload.
            name: input.title.trim().slice(0, PLAN_TITLE_MAX),
            status: 'pending',
            priority: input.priority,
            phaseId: input.phaseId?.trim().slice(0, 64),
            notes: input.notes?.trim().slice(0, PLAN_NOTES_MAX),
            createdAt: now,
            updatedAt: now,
          };
          // t56: declared file globs (council `fileRefs` vocabulary accepted).
          const files = normalizePlanTaskFiles(input.files ?? input.fileRefs);
          if (files) task.files = files;
          store.tasks.push(task);
          // t60: advisory overlap with OTHER in_progress tasks (never blocks).
          const overlaps = findOverlappingTasks(task.files, store.tasks, task.id);
          if (overlaps.length > 0) {
            applyOverlapAdvisory(task, overlaps);
            emitOverlapRadio(projectRoot, radioSession, task, overlaps);
          }
          writePlanTaskArtifact(store.rootDir, task);
          return typedOk(overlapResultValue({ id, task }, overlaps));
        });
        if (res.ok) {
          safeEmit(onTaskEvent, {
            type: 'task_update',
            source: 'workspace_plan',
            task: toTaskPayload(res.value.task),
          });
        }
        return res;
      } catch (err) {
        return typedErr(planStoreErrorMessage(err, 'task_create'));
      }
    },
  };

  const taskUpdate: ToolDefinition<
    z.infer<typeof UpdateSchema>,
    { task: PlanTask }
  > = {
    name: 'task_update',
    description:
      'Update a durable workspace task in .zelari/plan.json (status, title, ' +
      'priority, phaseId, notes, or appendNote). Accepts council-created ids ' +
      'too (task_list shows them). Errors with PLAN_TASK_NOT_FOUND on unknown ids.',
    permissions: ['write'],
    timeoutMs: 5_000,
    inputSchema: UpdateSchema,
    execute: async (input) => {
      try {
        const res = await withPlanStore(projectRoot, (store) => {
          const task = store.tasks.find((t) => t.id === input.id);
          if (!task) {
            return typedErr(
              `PLAN_TASK_NOT_FOUND: no task with id "${input.id}" in .zelari/plan.json ` +
                `(call task_list for current ids).`,
            );
          }
          if (input.title !== undefined) {
            task.title = input.title.trim().slice(0, PLAN_TITLE_MAX);
            // keep the council `name` alias in sync
            task.name = task.title;
          }
          if (input.status !== undefined) {
            task.status = input.status as PlanTaskStatus;
            // First completion wins: completedAt is append-only metadata and
            // survives reopens (t56) — staleness checks read the original date.
            if (input.status === 'completed' && task.completedAt === undefined) {
              task.completedAt = new Date().toISOString();
            }
          }
          if (input.priority !== undefined) task.priority = input.priority as PlanTaskPriority;
          if (input.phaseId !== undefined) task.phaseId = input.phaseId.slice(0, 64);
          const nextFiles = normalizePlanTaskFiles(input.files ?? input.fileRefs);
          if (nextFiles) task.files = nextFiles;
          if (input.notes !== undefined) {
            task.notes = input.notes.slice(0, PLAN_NOTES_MAX);
          }
          if (input.appendNote !== undefined) {
            const prev = typeof task.notes === 'string' ? task.notes : '';
            const merged = prev ? `${prev}\n${input.appendNote}` : input.appendNote;
            task.notes = merged.slice(-PLAN_NOTES_MAX);
          }
          // t60: advisory overlap when the task moves to in_progress.
          let overlaps: OverlapHit[] = [];
          if (input.status === 'in_progress' && task.files) {
            overlaps = findOverlappingTasks(task.files, store.tasks, task.id);
            if (overlaps.length > 0) {
              applyOverlapAdvisory(task, overlaps);
              emitOverlapRadio(projectRoot, radioSession, task, overlaps);
            }
          }
          task.updatedAt = new Date().toISOString();
          writePlanTaskArtifact(store.rootDir, task);
          return typedOk(overlapResultValue({ task }, overlaps));
        });
        if (res.ok) {
          safeEmit(onTaskEvent, {
            type: 'task_update',
            source: 'workspace_plan',
            task: toTaskPayload(res.value.task),
          });
        }
        return res;
      } catch (err) {
        return typedErr(planStoreErrorMessage(err, 'task_update'));
      }
    },
  };

  const taskList: ToolDefinition<
    z.infer<typeof ListSchema>,
    { tasks: PlanTask[]; total: number; done: number; formatted: string }
  > = {
    name: 'task_list',
    description:
      'List durable workspace tasks from .zelari/plan.json (both t<N> agent ' +
      'tasks and council-created plan tasks). Optional status/phaseId filters. ' +
      'Use before task_update to discover ids.',
    permissions: ['read'],
    timeoutMs: 5_000,
    inputSchema: ListSchema,
    execute: async (input) => {
      try {
        // Snapshot events carry the FULL task list (not the filtered view the
        // agent asked for), so consumers can use them as a complete refresh.
        let allPayloads: BrainTaskPayload[] = [];
        const res = await withPlanStore(projectRoot, (store) => {
          allPayloads = store.tasks.map(toTaskPayload);
          const filtered = store.tasks.filter(
            (t) =>
              (input.status === undefined || t.status === input.status) &&
              (input.phaseId === undefined || t.phaseId === input.phaseId),
          );
          const done = store.tasks.filter(
            (t) => t.status === 'completed' || t.status === 'cancelled',
          ).length;
          const formatted =
            filtered.length === 0
              ? '(no matching workspace tasks)'
              : filtered.map(taskSummaryLine).join('\n');
          return typedOk({
            tasks: filtered,
            total: store.tasks.length,
            done,
            formatted: `${formatted}\n(done/total: ${done}/${store.tasks.length})`,
          });
        });
        if (res.ok) {
          safeEmit(onTaskEvent, {
            type: 'task_snapshot',
            source: 'workspace_plan',
            tasks: allPayloads,
          });
        }
        return res;
      } catch (err) {
        return typedErr(planStoreErrorMessage(err, 'task_list'));
      }
    },
  };

  return [taskCreate, taskUpdate, taskList];
}

/**
 * t60: flag + advisory note on the task itself (advisory-only — the call
 * result is unaffected, writer serialization stays the lead policy).
 */
function applyOverlapAdvisory(task: PlanTask, overlaps: readonly OverlapHit[]): void {
  const flags = task.flags ? [...task.flags] : [];
  if (!flags.includes('overlap')) flags.push('overlap');
  task.flags = flags;
  const line = overlapNoteLine(overlaps);
  const prev = typeof task.notes === 'string' ? task.notes : '';
  task.notes = (prev ? `${prev}\n${line}` : line).slice(-PLAN_NOTES_MAX);
}

/** One best-effort radio event per overlapping pair (agent 'task-guard'). */
function emitOverlapRadio(
  projectRoot: string,
  sessionId: string,
  task: PlanTask,
  overlaps: readonly OverlapHit[],
): void {
  for (const hit of overlaps) {
    appendKrakenRadio(projectRoot, sessionId, {
      kind: 'task_overlap',
      agent: 'task-guard',
      description: `Task ${task.id} declares files overlapping in_progress ${hit.task.id}`,
      contestedFile: hit.contested,
    });
  }
}

/** Attach `overlapWarning` to the tool result only when hits exist (t60). */
function overlapResultValue<T extends object>(value: T, overlaps: readonly OverlapHit[]): T {
  if (overlaps.length === 0) return value;
  return { ...value, overlapWarning: overlaps.map((h) => `${h.task.id}: ${h.contested}`) };
}

function planStoreErrorMessage(err: unknown, tool: string): string {
  if (err instanceof PlanStoreError) return err.message;
  return `[${tool}] ${err instanceof Error ? err.message : String(err)}`;
}
