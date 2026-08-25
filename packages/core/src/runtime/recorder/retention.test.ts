import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enforceRunRetention, runRetentionFromEnv } from './retention.js';

let root: string;
// Realistic epoch-scale clock: startedAt values must stay positive for the
// age filter (a negative startedAt is treated as unknown/keep).
let clock = 1_700_000_000_000;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'zelari-retention-'));
  clock = 1_700_000_000_000;
});

afterEach(async () => {
  delete process.env.ZELARI_RUN_RETENTION_DAYS;
  delete process.env.ZELARI_RUN_RETENTION_MAX_MB;
  await rm(root, { recursive: true, force: true });
});

async function makeRun(name: string, opts: { startedAt: number; status: string; endedAt?: number; bytes?: number }): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({ version: 1, runId: name, startedAt: opts.startedAt, status: opts.status, ...(opts.endedAt !== undefined ? { endedAt: opts.endedAt } : {}) }),
  );
  if (opts.bytes) await writeFile(join(dir, 'blob.bin'), Buffer.alloc(opts.bytes));
}

const DAY = 24 * 60 * 60 * 1000;

describe('enforceRunRetention', () => {
  it('deletes expired completed runs and keeps active/unknown ones', async () => {
    await makeRun('old-completed', { startedAt: clock - 40 * DAY, status: 'completed', endedAt: clock - 39 * DAY, bytes: 10 });
    await makeRun('fresh-completed', { startedAt: clock - 1 * DAY, status: 'completed', endedAt: clock, bytes: 10 });
    await makeRun('still-running', { startedAt: clock - 40 * DAY, status: 'running', bytes: 10 });
    await mkdir(join(root, 'no-manifest'), { recursive: true });

    const result = await enforceRunRetention(root, { maxAgeDays: 30, now: () => clock });

    expect(result.deleted).toEqual(['old-completed']);
    expect(result.kept).toBe(3);
  });

  it('evicts oldest completed runs to fit the size budget', async () => {
    await makeRun('big-old', { startedAt: clock - 10 * DAY, status: 'completed', endedAt: clock, bytes: 800 });
    await makeRun('big-new', { startedAt: clock - 5 * DAY, status: 'completed', endedAt: clock, bytes: 800 });
    await makeRun('small-active', { startedAt: clock - 20 * DAY, status: 'running', bytes: 500 });

    const result = await enforceRunRetention(root, { maxTotalBytes: 1000, now: () => clock });

    // big-old (oldest completed) evicted; budget still over → big-new evicted too;
    // active run survives regardless of budget (§77).
    expect(result.deleted).toEqual(['big-old', 'big-new']);
    expect(result.freedBytes).toBeGreaterThanOrEqual(1600); // blobs + manifest bytes
    expect(result.kept).toBe(1);
  });

  it('returns an empty result when the runs dir does not exist', async () => {
    const result = await enforceRunRetention(join(root, 'missing'));
    expect(result.deleted).toEqual([]);
    expect(result.kept).toBe(0);
  });
});

describe('runRetentionFromEnv', () => {
  it('falls back to defaults and honors env overrides', () => {
    expect(runRetentionFromEnv()).toEqual({ maxAgeDays: 30, maxTotalBytes: 2048 * 1024 * 1024 });
    process.env.ZELARI_RUN_RETENTION_DAYS = '7';
    process.env.ZELARI_RUN_RETENTION_MAX_MB = '10';
    expect(runRetentionFromEnv()).toEqual({ maxAgeDays: 7, maxTotalBytes: 10 * 1024 * 1024 });
    process.env.ZELARI_RUN_RETENTION_DAYS = 'not-a-number';
    expect(runRetentionFromEnv().maxAgeDays).toBe(30);
  });
});
