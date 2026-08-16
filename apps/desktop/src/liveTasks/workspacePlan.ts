/**
 * Workspace project tasks (Desktop, M3 / ADR-0018).
 *
 * Reads `.zelari/plan.json` - written durably by the CLI `task_create` /
 * `task_update` / `task_list` tools - into the unified LiveTask model,
 * and applies the first-class `task_update` / `task_snapshot` BrainEvents
 * emitted by those tools after each durable write. Both carry the M2 run
 * envelope (runId / conversationId / cwd), so updates are routed by cwd
 * and never by the currently open chat.
 */
import { readProjectText } from "../agentClient";
import type { LiveTask, LiveTaskStatus } from "./types";

/** Defensive cap mirroring the CLI plan store (ADR-0018). */
const MAX_WORKSPACE_TASKS = 100;

/** Task payload of a BrainTaskUpdateEvent / BrainTaskSnapshotEvent. */
export interface WorkspaceBrainTask {
  id?: unknown;
  title?: unknown;
  name?: unknown;
  status?: unknown;
  phaseId?: unknown;
  priority?: unknown;
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
 * defensively: the payload crosses the NDJSON boundary untyped.
 */
export function brainTaskToLive(t: unknown): LiveTask | null {
  if (!t || typeof t !== "object") return null;
  const raw = t as WorkspaceBrainTask;
  const id = typeof raw.id === "string" && raw.id ? raw.id : "";
  const content = titleOf(raw).slice(0, 500);
  if (!id || !content) return null;
  return {
    id,
    content,
    status: normalizeStatus(raw.status),
    source: "project",
  };
}

/**
 * Parse a `.zelari/plan.json` document into project LiveTasks. Accepts
 * both the ADR-0018 envelope (`{ tasks: [...] }`, `title` field) and the
 * legacy council layout (`phases[].tasks[]`, `name` field, `done`
 * status) - same dual vocabulary the CLI store normalizes on read.
 */
export function parseWorkspacePlan(raw: unknown): LiveTask[] {
  if (!raw || typeof raw !== "object") return [];
  const root = raw as {
    tasks?: unknown;
    phases?: unknown;
  };
  const collected: WorkspaceBrainTask[] = [];
  const pushRaw = (v: unknown): void => {
    if (v && typeof v === "object") collected.push(v as WorkspaceBrainTask);
  };
  if (Array.isArray(root.tasks)) root.tasks.forEach(pushRaw);
  if (Array.isArray(root.phases)) {
    for (const p of root.phases) {
      const tasks = (p as { tasks?: unknown })?.tasks;
      if (Array.isArray(tasks)) tasks.forEach(pushRaw);
    }
  }
  const out: LiveTask[] = [];
  const seen = new Set<string>();
  for (const t of collected) {
    const live = brainTaskToLive(t);
    if (!live || seen.has(live.id)) continue;
    seen.add(live.id);
    out.push(live);
    if (out.length >= MAX_WORKSPACE_TASKS) break;
  }
  return out;
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

/**
 * Read `.zelari/plan.json` under `cwd` through the sandboxed Tauri
 * reader. Returns [] on missing/corrupt files - a missing plan is a
 * normal state, never an error surface.
 */
export async function loadWorkspaceTasks(cwd: string): Promise<LiveTask[]> {
  try {
    const res = await readProjectText({
      path: ".zelari/plan.json",
      cwd,
      maxBytes: 512 * 1024,
    });
    if (!res?.text) return [];
    return parseWorkspacePlan(JSON.parse(res.text));
  } catch {
    return [];
  }
}
