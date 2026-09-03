/**
 * Tauri I/O for workspace project tasks. Kept out of `workspacePlan.ts`
 * so render tests of LiveTasksPanel (which only need `groupProjectTasks`)
 * do not pull `@tauri-apps/api` — CI `npm test` never installs desktop
 * deps, so that import is unresolvable on the runner.
 */
import { readProjectText } from "../agentClient";
import { parseWorkspacePlan } from "./workspacePlan";
import type { LiveTask } from "./types";

/**
 * Per-cwd cache of the last plan read: signature + parsed tasks.
 * When the signature (mtimeMs+size) is unchanged we return the SAME
 * array reference, so React state setters bail out on Object.is and
 * the Live Tasks panel skips a pointless re-render.
 */
const planSigCache = new Map<string, { sig: string; tasks: LiveTask[] }>();

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
    if (!res?.text) {
      planSigCache.delete(cwd);
      return [];
    }
    const sig = `${res.mtimeMs}:${res.size}`;
    const hit = planSigCache.get(cwd);
    if (hit && hit.sig === sig) return hit.tasks;
    const tasks = parseWorkspacePlan(JSON.parse(res.text));
    planSigCache.set(cwd, { sig, tasks });
    return tasks;
  } catch {
    return [];
  }
}
