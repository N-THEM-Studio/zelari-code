/**
 * traceStore — persist & load per-mission execution traces (ADR-0015-A).
 *
 * Each mission's trace is saved as `.zelari/trace/<missionId>.json` containing
 * an array of {@link SliceTrace} entries — one per slice run. This enables
 * post-mortem debugging: "which member ran, in what order, how much did it
 * cost, and where did it diverge?" without digging through NDJSON logs.
 *
 * Side-effect-free helpers: the filesystem I/O is thin (read/write JSON).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** Re-export for convenience (the authoritative type lives in zelariMission). */
export interface TraceEntry {
  sliceId: string;
  iteration: number;
  runMode: string;
  completionOk: boolean;
  degraded?: boolean;
  costTokens?: number;
  costUsd?: number;
  startedAt: string;
  durationMs: number;
}

export interface MissionTraceFile {
  missionId: string;
  ts: number;
  entries: TraceEntry[];
}

/** Directory where trace files are persisted. */
export function traceDir(projectRoot: string): string {
  return path.join(projectRoot, '.zelari', 'trace');
}

/** Full path for a single mission's trace file. */
export function tracePath(projectRoot: string, missionId: string): string {
  return path.join(traceDir(projectRoot), `${missionId}.json`);
}

/**
 * Save (or append to) the trace file for a mission.
 * Overwrites the entire file with the latest trace array — the mission
 * driver calls this after each slice, so the file always reflects the
 * latest state.
 */
export async function saveTrace(
  projectRoot: string,
  missionId: string,
  entries: TraceEntry[],
): Promise<void> {
  const dir = traceDir(projectRoot);
  await fs.mkdir(dir, { recursive: true });
  const payload: MissionTraceFile = {
    missionId,
    ts: Date.now(),
    entries,
  };
  await fs.writeFile(
    tracePath(projectRoot, missionId),
    JSON.stringify(payload, null, 2) + '\n',
    'utf8',
  );
}

/**
 * Load the trace file for a mission. Returns `null` if the file does not
 * exist (e.g. mission pre-dates the trace feature).
 */
export async function loadTrace(
  projectRoot: string,
  missionId: string,
): Promise<MissionTraceFile | null> {
  try {
    const raw = await fs.readFile(
      tracePath(projectRoot, missionId),
      'utf8',
    );
    return JSON.parse(raw) as MissionTraceFile;
  } catch {
    return null;
  }
}

/**
 * List all mission trace files in the `.zelari/trace/` directory.
 * Returns `{ missionId, ts, entries: number }[]` sorted by ts descending.
 */
export async function listTraces(
  projectRoot: string,
): Promise<{ missionId: string; ts: number; entries: number }[]> {
  const dir = traceDir(projectRoot);
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const results: { missionId: string; ts: number; entries: number }[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const missionId = f.replace(/\.json$/, '');
    try {
      const raw = await fs.readFile(path.join(dir, f), 'utf8');
      const parsed = JSON.parse(raw) as MissionTraceFile;
      results.push({
        missionId,
        ts: parsed.ts ?? 0,
        entries: parsed.entries?.length ?? 0,
      });
    } catch {
      // skip corrupted files
    }
  }
  results.sort((a, b) => b.ts - a.ts);
  return results;
}
