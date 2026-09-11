/**
 * Tauri I/O for the persisted Zelari mission (`.zelari/mission-state.json`).
 *
 * Mirrors `workspacePlanIo.ts`: the sandboxed project reader
 * (`read_project_text`) is reused, so no dedicated Tauri command is added, and
 * a missing/unparseable file is a normal state (null), never an error surface.
 */
import { readProjectText } from "../agentClient";
import { parseMissionState, type MissionStateView } from "./missionState";

/**
 * Per-cwd cache of the last mission read: signature + parsed view. When the
 * signature (mtimeMs+size) is unchanged we return the SAME object, so the
 * React setter bails out on Object.is and the Live Tasks panel skips a
 * pointless re-render (focus re-reads, run-finished reconciliation).
 */
const missionSigCache = new Map<
  string,
  { sig: string; view: MissionStateView | null }
>();

/**
 * Read the Zelari mission of `cwd` through the sandboxed Tauri reader.
 * Returns null when the file is absent, unreadable or not a mission state —
 * "no mission here" is the common case and must not render anything.
 */
export async function loadMissionState(
  cwd: string,
): Promise<MissionStateView | null> {
  try {
    const res = await readProjectText({
      path: ".zelari/mission-state.json",
      cwd,
      maxBytes: 256 * 1024,
    });
    if (!res?.text) {
      missionSigCache.delete(cwd);
      return null;
    }
    const sig = `${res.mtimeMs}:${res.size}`;
    const hit = missionSigCache.get(cwd);
    if (hit && hit.sig === sig) return hit.view;
    const view = parseMissionState(JSON.parse(res.text));
    missionSigCache.set(cwd, { sig, view });
    return view;
  } catch {
    return null;
  }
}
