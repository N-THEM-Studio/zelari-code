import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionJsonlWriter, readSession } from '../../packages/core/src/core/sessionJsonl.js';
import type { BrainEvent } from '../../packages/core/src/shared/events.js';

/**
 * v1.35 batching: per-token events are line-buffered and flushed on
 * thresholds / cadence / explicit flush. Ordering and durability contracts
 * are pinned here.
 */

let dir: string;

function tempDir(): string {
  dir = path.join(os.tmpdir(), `zelari-sessionjsonl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  return dir;
}

afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

function ev(n: number): BrainEvent {
  return {
    type: 'message_delta',
    ts: n,
    sessionId: 's1',
    messageId: 'm1',
    delta: `chunk-${n}`,
  } as unknown as BrainEvent;
}

describe('SessionJsonlWriter — batched appends', () => {
  it('flush() makes queued events durable in order', async () => {
    const w = new SessionJsonlWriter('batched-1', { baseDir: tempDir() });
    void w.append(ev(1));
    void w.append(ev(2));
    void w.append(ev(3));
    await w.flush();
    const events = await readSession(w.path);
    expect(events.map((e) => (e as { ts: number }).ts)).toEqual([1, 2, 3]);
    await w.close();
  });

  it('threshold flush writes a single batch without an explicit flush()', async () => {
    const w = new SessionJsonlWriter('batched-2', { baseDir: tempDir(), flushIntervalMs: 60_000 });
    for (let i = 0; i < 31; i++) {
      void w.append(ev(i));
    }
    // 31 < 32 threshold: nothing on disk yet (cadence is effectively disabled).
    expect((await readSession(w.path)).length).toBe(0);
    // The 32nd event crosses the threshold — awaiting its append waits for
    // the batch write.
    await w.append(ev(31));
    const events = await readSession(w.path);
    expect(events).toHaveLength(32);
    await w.close();
  });

  it('append() resolves only after the event is durable (cadence path)', async () => {
    const w = new SessionJsonlWriter('batched-3', { baseDir: tempDir(), flushIntervalMs: 20 });
    await w.append(ev(7));
    const events = await readSession(w.path);
    expect(events.map((e) => (e as { ts: number }).ts)).toEqual([7]);
    await w.close();
  });

  it('close() drains the pending tail', async () => {
    const w = new SessionJsonlWriter('batched-4', { baseDir: tempDir(), flushIntervalMs: 60_000 });
    void w.append(ev(1));
    await w.close();
    const events = await readSession(w.path);
    expect(events).toHaveLength(1);
  });
});
