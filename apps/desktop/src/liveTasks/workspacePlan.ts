/**
 * Workspace project tasks (Desktop, M3 / ADR-0018).
 *
 * Reads `.zelari/plan.json` - written durably by the CLI `task_create` /
 * `task_update` / `task_list` tools - into the unified LiveTask model,
 * and applies the first-hand `task_update` / `task_snapshot` BrainEvents
 * emitted by those tools after each durable write. Both carry the M2 run
 * envelope (runId / conversationId / cwd), so updates are routed by cwd
 * and never by the currently open chat.
 *
 * This module is Tauri-free on purpose: LiveTasksPanel render tests
 * import `groupProjectTasks` and CI `npm test` never installs
 * `@tauri-apps/api`. I/O lives in `workspacePlanIo.ts`.
 */
import type { LiveTask, LiveTaskStatus } from "./types";

/** Defensive cap mirroring the CLI plan store (ADR-0018). */
const MAX_WORKSPACE_TASKS = 100;

/** Fallback order for tasks whose phase has no numeric `order`. */
const PHASE_ORDER_FALLBACK = 9_999;

/** Task payload of a BrainTaskUpdateEvent / BrainTaskSnapshotEvent. */
export interface WorkspaceBrainTask {
  id?: unknown;
  title?: unknown;
  name?: unknown;
  status?: unknown;
  phaseId?: unknown;
  priority?: unknown;
  flags?: unknown;
}

/** Phase metadata of a `.zelari/plan.json` `phases[]` entry. */
interface PhaseMeta {
  name?: string;
  order?: number;
}

/**
 * Canonical in-memory key for a cwd. Windows paths are case-insensitive
 * and may arrive with either separator - mirror the Rust run-registry
 * canonicalization (M2) so event routing and UI lookups always agree.
 */
export function normalizeCwdKey(cwd: string): string {
  return cwd.trim().toLowerCase().replace(/\\/g, "/");
}

function normalizeStatus(v: unknown): LiveTaskStatus {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  if (
    s === "in_progress" ||
    s === "completed" ||
    s === "cancelled" ||
    s === "blocked"
  ) {
    return s;
  }
  // Council legacy vocabulary ("done") -> canonical (ADR-0018 dual
  // vocabulary, same normalization the CLI store applies on read).
  if (s === "done") return "completed";
  return "pending";
}

function titleOf(t: WorkspaceBrainTask): string {
  for (const v of [t.title, t.name]) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/**
 * Map a BrainEvent task payload into the unified model. Accepts `unknown`
 * defensively: the payload crosses the NDJSON boundary untyped. Preserves
 * `phaseId` when present so BrainEvent updates keep the grouping of the
 * task they replace.
 */
export function brainTaskToLive(t: unknown): LiveTask | null {
  if (!t || typeof t !== "object") return null;
  const raw = t as WorkspaceBrainTask;
  const id = typeof raw.id === "string" && raw.id ? raw.id : "";
  const content = titleOf(raw).slice(0, 500);
  if (!id || !content) return null;
  const live: LiveTask = {
    id,
    content,
    status: normalizeStatus(raw.status),
    source: "project",
  };
  if (typeof raw.phaseId === "string" && raw.phaseId) {
    live.phaseId = raw.phaseId;
  }
  if (Array.isArray(raw.flags)) {
    const flags = raw.flags.filter(
      (f): f is string => typeof f === "string" && !!f,
    );
    if (flags.length) live.flags = flags;
  }
  return live;
}

/**
 * Parse a `.zelari/plan.json` document into project LiveTasks. Accepts
 * both the ADR-0018 envelope (`{ tasks: [...] }`, `title` field) and the
 * legacy council layout (`phases[].tasks[]`, `name` field, `done`
 * status) - same dual vocabulary the CLI store normalizes on read.
 *
 * Phase metadata (`phases[].name` / `phases[].order`) is attached to
 * every task and the result is sorted by phase order (stable, file order
 * within a phase), so the Project panel always renders the plan's P0 →
 * Release sequencing regardless of how the tasks are laid out in the
 * file.
 */
export function parseWorkspacePlan(raw: unknown): LiveTask[] {
  if (!raw || typeof raw !== "object") return [];
  const root = raw as {
    tasks?: unknown;
    phases?: unknown;
  };

  const phaseMeta = new Map<string, PhaseMeta>();
  const collected: Array<{ raw: WorkspaceBrainTask; phaseId?: string }> = [];
  const pushRaw = (v: unknown, phaseId?: string): void => {
    if (v && typeof v === "object") {
      collected.push({ raw: v as WorkspaceBrainTask, phaseId });
    }
  };

  if (Array.isArray(root.phases)) {
    for (const p of root.phases) {
      if (!p || typeof p !== "object") continue;
      const po = p as { id?: unknown; name?: unknown; order?: unknown };
      if (typeof po.id !== "string" || !po.id) continue;
      phaseMeta.set(po.id, {
        name: typeof po.name === "string" ? po.name : undefined,
        order: typeof po.order === "number" ? po.order : undefined,
      });
      // Legacy nested layout: tasks live inside the phase.
      if (Array.isArray((p as { tasks?: unknown }).tasks)) {
        for (const t of (p as { tasks: unknown[] }).tasks) {
          pushRaw(t, po.id);
        }
      }
    }
  }
  // Canonical ADR-0018 layout: flat `tasks[]`, each with `phaseId`.
  if (Array.isArray(root.tasks)) root.tasks.forEach((t) => pushRaw(t));

  const out: LiveTask[] = [];
  const seen = new Set<string>();
  for (const { raw: t, phaseId: nestedPhaseId } of collected) {
    const live = brainTaskToLive(t);
    if (!live || seen.has(live.id)) continue;
    seen.add(live.id);
    const phaseId = live.phaseId ?? nestedPhaseId;
    if (phaseId) {
      const meta = phaseMeta.get(phaseId);
      live.phaseId = phaseId;
      live.phaseLabel = meta?.name;
      live.phaseOrder = meta?.order ?? PHASE_ORDER_FALLBACK;
    }
    out.push(live);
    if (out.length >= MAX_WORKSPACE_TASKS) break;
  }
  out.sort(
    (a, b) => (a.phaseOrder ?? PHASE_ORDER_FALLBACK) - (b.phaseOrder ?? PHASE_ORDER_FALLBACK),
  );
  return out;
}

/** A phase bucket of the Project panel (`groupProjectTasks`). */
export interface ProjectTaskGroup {
  /** Phase id, or `"_none"` for tasks without a phase. */
  key: string;
  /** Human phase name from `phases[].name`, or a neutral fallback. */
  label: string;
  tasks: LiveTask[];
}

/**
 * Group project tasks by phase, preserving the incoming (phase-ordered)
 * sequence. Pure and deterministic - safe to call on every render.
 */
export function groupProjectTasks(tasks: LiveTask[]): ProjectTaskGroup[] {
  const groups: ProjectTaskGroup[] = [];
  const byKey = new Map<string, ProjectTaskGroup>();
  for (const t of tasks) {
    const key = t.phaseId ?? "_none";
    let g = byKey.get(key);
    if (!g) {
      g = { key, label: t.phaseLabel ?? "Generale", tasks: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.tasks.push(t);
  }
  return groups;
}

/** Replace the project tasks of one workspace key (immutable). */
export function applyWorkspaceSnapshot(
  map: Record<string, LiveTask[]>,
  cwdKey: string,
  tasks: LiveTask[],
): Record<string, LiveTask[]> {
  if (!cwdKey) return map;
  return { ...map, [cwdKey]: tasks };
}

/** Upsert a single project task into one workspace key (immutable). */
export function applyWorkspaceUpdate(
  map: Record<string, LiveTask[]>,
  cwdKey: string,
  task: LiveTask,
): Record<string, LiveTask[]> {
  if (!cwdKey) return map;
  const prev = map[cwdKey] ?? [];
  const i = prev.findIndex((t) => t.id === task.id);
  const next = [...prev];
  if (i >= 0) next[i] = task;
  else next.push(task);
  return { ...map, [cwdKey]: next };
}
