/**
 * spineLockSweep tests — orphan writer.lock cleanup at sidecar boot.
 * Uses a REAL dead pid (spawned child that already exited) against the
 * default signal-0 probe, and the test runner's own live pid as the keeper.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sweepOrphanSpineLocks } from './spineLockSweep.js';

let tmp: string;

afterEach(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

async function tmpSessionsDir(): Promise<string> {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-spine-sweep-'));
  return tmp;
}

/** A pid that is guaranteed dead: a child that already exited with 0. */
function deadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    child.on('exit', (code) => (code === 0 && child.pid ? resolve(child.pid) : reject(new Error('probe child failed'))));
    child.on('error', reject);
  });
}

async function seedLock(sessionsDir: string, sessionId: string, payload: Record<string, unknown>): Promise<void> {
  const dir = path.join(sessionsDir, sessionId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'writer.lock'), JSON.stringify(payload), 'utf-8');
}

describe('sweepOrphanSpineLocks', () => {
  it('sweeps a dead-pid lock and keeps a live-owner lock (own pid, fresh ts)', async () => {
    const dir = await tmpSessionsDir();
    const dead = await deadPid();
    await seedLock(dir, 'sess-dead', { ownership: 'ghost', pid: dead, ts: Date.now() });
    await seedLock(dir, 'sess-live', { ownership: 'mine', pid: process.pid, ts: Date.now() });
    const swept: Array<[string, string]> = [];
    const res = await sweepOrphanSpineLocks(dir, { onSwept: (id, reason) => swept.push([id, reason]) });
    expect(res.swept).toBe(1);
    expect(res.kept).toBe(1);
    expect(res.errors).toBe(0);
    expect(swept).toEqual([['sess-dead', 'pid-dead']]);
    await expect(fs.access(path.join(dir, 'sess-dead', 'writer.lock'))).rejects.toThrow();
    await expect(fs.access(path.join(dir, 'sess-live', 'writer.lock'))).resolves.toBeUndefined();
  });

  it('sweeps a heartbeat-stale lock even when the owner pid is alive', async () => {
    const dir = await tmpSessionsDir();
    await seedLock(dir, 'sess-hb', {
      ownership: 'stale',
      pid: process.pid,
      ts: Date.now() - 10 * 60 * 1000, // alive owner, but 10 min without a heartbeat
    });
    const res = await sweepOrphanSpineLocks(dir, { onSwept: () => undefined });
    expect(res.swept).toBe(1);
    await expect(fs.access(path.join(dir, 'sess-hb', 'writer.lock'))).rejects.toThrow();
  });

  it('is a no-op on a missing sessions dir and never throws', async () => {
    const missing = path.join(os.tmpdir(), 'zelari-spine-sweep-missing-' + Date.now());
    const res = await sweepOrphanSpineLocks(missing);
    expect(res).toEqual({ swept: 0, kept: 0, errors: 0 });
  });

  it('skips sessions without a lock and counts corrupt locks as kept (best-effort)', async () => {
    const dir = await tmpSessionsDir();
    await seedLock(dir, 'sess-nolock', { ownership: 'x', pid: 1, ts: Date.now() });
    await fs.rm(path.join(dir, 'sess-nolock', 'writer.lock'));
    await seedLock(dir, 'sess-corrupt', {});
    await fs.writeFile(path.join(dir, 'sess-corrupt', 'writer.lock'), '{not json', 'utf-8');
    const res = await sweepOrphanSpineLocks(dir, { probe: () => false });
    expect(res.swept).toBe(0);
    expect(res.kept).toBe(1);
    expect(res.errors).toBe(0);
  });
});
