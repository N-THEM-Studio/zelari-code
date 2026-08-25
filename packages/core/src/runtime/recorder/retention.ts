/**
 * Run retention (Frontier PHASE 5, §77): keep `.zelari/runs` bounded.
 *
 * - never deletes a run whose manifest is missing `endedAt`/final status
 *   (active or unknown runs are conservatively kept)
 * - deletes completed runs older than `maxAgeDays`
 * - then deletes oldest completed runs until total size fits `maxTotalBytes`
 *
 * Env: ZELARI_RUN_RETENTION_DAYS (default 30),
 *      ZELARI_RUN_RETENTION_MAX_MB (default 2048).
 */
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface RunRetentionOptions {
  maxAgeDays?: number;
  maxTotalBytes?: number;
  now?: () => number;
}

export interface RetentionResult {
  deleted: string[];
  freedBytes: number;
  kept: number;
}

export const DEFAULT_RUN_RETENTION_DAYS = 30;
export const DEFAULT_RUN_RETENTION_MAX_MB = 2048;

export function runRetentionFromEnv(): Required<Pick<RunRetentionOptions, 'maxAgeDays' | 'maxTotalBytes'>> {
  const parseDays = Number(process.env.ZELARI_RUN_RETENTION_DAYS);
  const parseMb = Number(process.env.ZELARI_RUN_RETENTION_MAX_MB);
  return {
    maxAgeDays: Number.isFinite(parseDays) && parseDays > 0 ? parseDays : DEFAULT_RUN_RETENTION_DAYS,
    maxTotalBytes:
      Number.isFinite(parseMb) && parseMb > 0 ? Math.round(parseMb * 1024 * 1024) : DEFAULT_RUN_RETENTION_MAX_MB * 1024 * 1024,
  };
}

interface RunDirInfo {
  name: string;
  path: string;
  startedAt: number;
  endedAt?: number;
  completed: boolean;
  bytes: number;
}

async function dirSize(path: string): Promise<number> {
  let total = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await dirSize(child);
    else {
      try {
        total += (await stat(child)).size;
      } catch {
        /* vanished mid-walk */
      }
    }
  }
  return total;
}

export async function enforceRunRetention(
  runsDir: string,
  options: RunRetentionOptions = {},
): Promise<RetentionResult> {
  const now = options.now ?? Date.now;
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_RUN_RETENTION_DAYS;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_RUN_RETENTION_MAX_MB * 1024 * 1024;

  const result: RetentionResult = { deleted: [], freedBytes: 0, kept: 0 };
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch {
    return result; // no runs dir yet → nothing to do
  }

  const infos: RunDirInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(runsDir, entry.name);
    let startedAt = 0;
    let endedAt: number | undefined;
    let completed = false;
    try {
      const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')) as {
        startedAt?: number;
        endedAt?: number;
        status?: string;
      };
      startedAt = manifest.startedAt ?? 0;
      endedAt = manifest.endedAt;
      // §77: only finalized runs are deletable; 'running' / unknown stay.
      completed = Boolean(endedAt) && manifest.status !== 'running';
    } catch {
      completed = false; // unreadable manifest → conservative keep
    }
    infos.push({ name: entry.name, path, startedAt, endedAt, completed, bytes: await dirSize(path) });
  }

  const remove = async (info: RunDirInfo): Promise<void> => {
    await rm(info.path, { recursive: true, force: true });
    result.deleted.push(info.name);
    result.freedBytes += info.bytes;
  };

  // Pass 1: age-based eviction (oldest first).
  const ageCutoffMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const expired = infos
    .filter((info) => info.completed && info.startedAt > 0 && now() - info.startedAt > ageCutoffMs)
    .sort((a, b) => a.startedAt - b.startedAt);
  for (const info of expired) await remove(info);

  // Pass 2: size-budget eviction over what is left (oldest completed first).
  const survivors = infos.filter((info) => !result.deleted.includes(info.name));
  let totalBytes = survivors.reduce((sum, info) => sum + info.bytes, 0);
  const byOldest = survivors.filter((info) => info.completed).sort((a, b) => a.startedAt - b.startedAt);
  for (const info of byOldest) {
    if (totalBytes <= maxTotalBytes) break;
    totalBytes -= info.bytes;
    await remove(info);
  }

  result.kept = infos.filter((info) => !result.deleted.includes(info.name)).length;
  return result;
}
