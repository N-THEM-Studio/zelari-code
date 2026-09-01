import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_HEARTBEAT_STALE_MS,
  LockTakeoverVerdict,
  SessionLogLockedError,
  SessionLogWriter,
  evaluateLockTakeover,
  resolveHeartbeatStaleMs,
} from './writer.js';
import { ACTOR_USER } from './types.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'zelari-session-test-'));
}

/** Seed a pre-existing writer.lock (as a crashed foreign writer would leave it). */
async function seedLock(dir: string, payload: Record<string, unknown>): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'writer.lock'), JSON.stringify(payload), 'utf-8');
}

async function readLock(dir: string): Promise<{ ownership?: string; pid?: number; ts?: number }> {
  return JSON.parse(await fs.readFile(path.join(dir, 'writer.lock'), 'utf-8'));
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

  it('takes over immediately when the lock pid is dead (liveness)', async () => {
    const dir = await tmpDir();
    // Fresh ts (NOT 10-min stale) but a provably dead owner pid.
    await seedLock(dir, { ownership: 'ghost', pid: 999_999_999, ts: Date.now() });
    const w = await SessionLogWriter.open(dir, 'sess-f', 1, { probe: () => false });
    const e = await w.append({ kind: 'note', actor: ACTOR_USER, data: {} });
    expect(e.seq).toBe(1); // acquired despite the fresh-looking foreign lock
    const lock = await readLock(dir);
    expect(lock.pid).toBe(process.pid); // rewritten with our own pid
    expect(lock.ownership).not.toBe('ghost');
    await w.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('keeps throwing SessionLogLockedError when the owner is alive and fresh', async () => {
    const dir = await tmpDir();
    // Default probe on our own pid = alive; ts = now → fresh heartbeat.
    await seedLock(dir, { ownership: 'live-owner', pid: process.pid, ts: Date.now() });
    await expect(SessionLogWriter.open(dir, 'sess-g', 1)).rejects.toBeInstanceOf(
      SessionLogLockedError,
    );
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('takes over a LIVE owner whose heartbeat is stale (pid reuse / hung owner)', async () => {
    const dir = await tmpDir();
    // Alive pid (test runner) but ts 10 minutes old — well past the 120 s
    // heartbeat threshold yet NOT past the 10-minute legacy staleness rule.
    await seedLock(dir, { ownership: 'stale-heartbeat', pid: process.pid, ts: Date.now() - 10 * 60 * 1000 });
    const w = await SessionLogWriter.open(dir, 'sess-h', 1);
    const e = await w.append({ kind: 'note', actor: ACTOR_USER, data: {} });
    expect(e.seq).toBe(1);
    await w.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('preserves the legacy >10min staleness takeover for pid-less locks', async () => {
    const dir = await tmpDir();
    await seedLock(dir, { ownership: 'legacy', ts: Date.now() - 11 * 60 * 1000 });
    const w = await SessionLogWriter.open(dir, 'sess-i', 1);
    const e = await w.append({ kind: 'note', actor: ACTOR_USER, data: {} });
    expect(e.seq).toBe(1);
    await w.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('append refreshes the lock heartbeat, throttled to ~1 refresh/second', async () => {
    const dir = await tmpDir();
    let t = 1_000_000;
    const writer = await SessionLogWriter.open(dir, 'sess-j', 1, { now: () => t });
    expect((await readLock(dir)).ts).toBe(1_000_000);
    t = 1_005_000; // +5 s → past the 1 s throttle → heartbeat rewrite
    await writer.append({ kind: 'note', actor: ACTOR_USER, data: {} });
    expect((await readLock(dir)).ts).toBe(1_005_000);
    t = 1_005_500; // +0.5 s → throttled, ts unchanged
    await writer.append({ kind: 'note', actor: ACTOR_USER, data: {} });
    expect((await readLock(dir)).ts).toBe(1_005_000);
    await writer.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('evaluateLockTakeover (pure decision helper)', () => {
  const now = 10_000_000;
  const alive = () => true;
  const dead = () => false;

  it('follows the documented decision order', () => {
    const v = (takeover: boolean, reason: string): LockTakeoverVerdict =>
      ({ takeover, reason }) as LockTakeoverVerdict;
    // 1. pid dead → takeover immediately.
    expect(evaluateLockTakeover({ pid: 1, ts: now }, { now, probe: dead })).toEqual(
      v(true, 'pid-dead'),
    );
    // 2. alive + fresh → locked.
    expect(evaluateLockTakeover({ pid: 1, ts: now - 1_000 }, { now, probe: alive })).toEqual(
      v(false, 'alive-fresh'),
    );
    // 3. alive + heartbeat-stale → takeover.
    expect(evaluateLockTakeover({ pid: 1, ts: now - 121_000 }, { now, probe: alive })).toEqual(
      v(true, 'heartbeat-stale'),
    );
    // 4. no pid + >10 min stale → legacy takeover; no pid + fresh → locked.
    expect(evaluateLockTakeover({ ts: now - 601_000 }, { now, probe: alive })).toEqual(
      v(true, 'stale'),
    );
    expect(evaluateLockTakeover({ ts: now - 1_000 }, { now, probe: alive })).toEqual(
      v(false, 'no-pid-locked'),
    );
  });

  it('heartbeat threshold is env-overridable and validated', () => {
    expect(DEFAULT_HEARTBEAT_STALE_MS).toBe(120_000);
    expect(resolveHeartbeatStaleMs({ ZELARI_SPINE_HEARTBEAT_STALE_MS: '5000' })).toBe(5000);
    expect(resolveHeartbeatStaleMs({})).toBe(120_000);
    expect(resolveHeartbeatStaleMs({ ZELARI_SPINE_HEARTBEAT_STALE_MS: 'nope' })).toBe(120_000);
    expect(resolveHeartbeatStaleMs({ ZELARI_SPINE_HEARTBEAT_STALE_MS: '-3' })).toBe(120_000);
  });
});
