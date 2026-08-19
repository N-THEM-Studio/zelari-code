import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionLogLockedError, SessionLogWriter } from './writer.js';
import { ACTOR_USER } from './types.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'zelari-session-test-'));
}

describe('SessionLogWriter', () => {
  it('assigns a monotonic gap-free seq and writes one JSON line per event', async () => {
    const dir = await tmpDir();
    const writer = await SessionLogWriter.open(dir, 'sess-a', 1);
    const e1 = await writer.append({ kind: 'user.message', actor: ACTOR_USER, data: { text: 'ciao' } });
    const e2 = await writer.append({ kind: 'note', actor: ACTOR_USER, data: {} });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    const content = await fs.readFile(writer.path, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).seq).toBe(1);
    expect(JSON.parse(lines[1]).schemaVersion).toBe(1);
    await writer.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('rejects unknown event kinds without consuming a seq', async () => {
    const dir = await tmpDir();
    const writer = await SessionLogWriter.open(dir, 'sess-b', 1);
    const first = await writer.append({ kind: 'note', actor: ACTOR_USER, data: {} });
    await expect(
      // @ts-expect-error — deliberately invalid kind
      writer.append({ kind: 'not.a.kind', actor: ACTOR_USER, data: {} }),
    ).rejects.toThrow();
    const second = await writer.append({ kind: 'note', actor: ACTOR_USER, data: {} });
    expect(second.seq).toBe(first.seq + 1);
    await writer.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('enforces single-writer ownership (second writer gets SessionLogLockedError)', async () => {
    const dir = await tmpDir();
    const w1 = await SessionLogWriter.open(dir, 'sess-c', 1);
    await w1.append({ kind: 'note', actor: ACTOR_USER, data: {} });
    await expect(SessionLogWriter.open(dir, 'sess-c', 2)).rejects.toBeInstanceOf(SessionLogLockedError);
    await w1.close();
    // After close the lock is released: a new writer can continue the seq.
    const w2 = await SessionLogWriter.open(dir, 'sess-c', 2);
    const e = await w2.append({ kind: 'note', actor: ACTOR_USER, data: {} });
    expect(e.seq).toBe(2);
    await w2.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('takes over a stale lock after staleLockMs', async () => {
    const dir = await tmpDir();
    const t0 = 1_000_000;
    const w1 = await SessionLogWriter.open(dir, 'sess-d', 1, { now: () => t0 });
    await w1.append({ kind: 'note', actor: ACTOR_USER, data: {} });
    // Do NOT close w1 — simulate a crashed writer. Advance the clock far ahead.
    const w2 = await SessionLogWriter.open(dir, 'sess-d', 2, {
      now: () => t0 + 60 * 60 * 1000,
      staleLockMs: 10 * 60 * 1000,
    });
    const e = await w2.append({ kind: 'note', actor: ACTOR_USER, data: {} });
    expect(e.seq).toBe(2);
    await w2.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
