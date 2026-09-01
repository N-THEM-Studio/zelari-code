/**
 * session/writer.ts — single-writer append-only JSONL log with ownership lock.
 *
 * Ownership: `<sessionDir>/writer.lock` is created with flag 'wx' holding
 * `{ownership, pid, ts}`. A second writer gets SessionLogLockedError; a stale
 * lock (older than staleLockMs) may be taken over. `seq` is assigned after
 * Zod validation of the envelope — a rejected event never consumes a seq.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  SESSION_SCHEMA_VERSION,
  SessionEventEnvelopeSchema,
  type SessionEventEnvelope,
  type SessionEventInput,
} from './types.js';

export class SessionLogLockedError extends Error {
  readonly code = 'SESSION_LOG_LOCKED';
  constructor(
    public readonly sessionPath: string,
    public readonly owner: string,
  ) {
    super(`Session log is locked by another writer: ${sessionPath} (owner=${owner})`);
    this.name = 'SessionLogLockedError';
  }
}

export interface SessionLogWriterOptions {
  /** Locks older than this may be taken over. Default 10 minutes. */
  staleLockMs?: number;
  /** Heartbeat-stale threshold for a LIVE owner. Default 120 s (env ZELARI_SPINE_HEARTBEAT_STALE_MS). */
  heartbeatStaleMs?: number;
  /** Liveness probe for the lock owner pid (injectable for tests). */
  probe?: LockLivenessProbe;
  /** Injectable clock for tests. */
  now?: () => number;
}

const DEFAULT_STALE_LOCK_MS = 10 * 60 * 1000;

/** Parsed shape of a `writer.lock` payload (all fields optional/tolerant). */
export interface LockInfo {
  ownership?: string;
  /** Owner pid — absent on pre-liveness locks; never trusted without a probe. */
  pid?: number;
  /** Lock creation/heartbeat ts (ms epoch); 0/undefined = unknown. */
  ts?: number;
}

/** Liveness probe for a pid: true = alive. Injectable for tests. */
export type LockLivenessProbe = (pid: number) => boolean;

/** Default probe: signal 0 — ESRCH ⇒ dead, anything else (EPERM…) ⇒ alive. */
export function defaultLockLivenessProbe(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export const DEFAULT_HEARTBEAT_STALE_MS = 120_000;

/** Heartbeat-stale threshold: explicit value > env ZELARI_SPINE_HEARTBEAT_STALE_MS > 120 s. */
export function resolveHeartbeatStaleMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.ZELARI_SPINE_HEARTBEAT_STALE_MS;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_HEARTBEAT_STALE_MS;
}

export type LockTakeoverVerdict =
  | { takeover: true; reason: 'pid-dead' | 'heartbeat-stale' | 'stale' }
  | { takeover: false; reason: 'alive-fresh' | 'no-pid-locked' };

/**
 * Pure takeover decision for an existing writer.lock, shared by the writer
 * and the CLI boot sweep (spineLockSweep). Decision order:
 *  1. lock pid dead ⇒ takeover immediately;
 *  2. pid alive + ts fresher than the heartbeat threshold ⇒ stay locked;
 *  3. pid alive but heartbeat-stale ⇒ likely PID reuse or a hung owner ⇒
 *     takeover. MIXED-VERSION CAVEAT: writers from pre-heartbeat versions
 *     never refresh ts on append, so a LIVE-but-idle old writer can be
 *     misjudged stale here — accepted trade-off for liveness recovery;
 *  4. lock without a usable pid ⇒ legacy 10-minute staleness rule.
 */
export function evaluateLockTakeover(
  lockInfo: LockInfo,
  opts: { now: number; probe: LockLivenessProbe; heartbeatStaleMs?: number; staleLockMs?: number },
): LockTakeoverVerdict {
  const heartbeatStaleMs = opts.heartbeatStaleMs ?? DEFAULT_HEARTBEAT_STALE_MS;
  const staleLockMs = opts.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const ts =
    typeof lockInfo.ts === 'number' && Number.isFinite(lockInfo.ts) && lockInfo.ts > 0
      ? lockInfo.ts
      : 0;
  const pid =
    typeof lockInfo.pid === 'number' && Number.isFinite(lockInfo.pid) && lockInfo.pid > 0
      ? lockInfo.pid
      : undefined;
  if (pid !== undefined) {
    if (!opts.probe(pid)) return { takeover: true, reason: 'pid-dead' };
    if (ts > 0 && opts.now - ts < heartbeatStaleMs) return { takeover: false, reason: 'alive-fresh' };
    return { takeover: true, reason: 'heartbeat-stale' };
  }
  if (ts > 0 && opts.now - ts > staleLockMs) return { takeover: true, reason: 'stale' };
  return { takeover: false, reason: 'no-pid-locked' };
}

export class SessionLogWriter {
  private readonly eventsPath: string;
  private readonly lockPath: string;
  private readonly ownership = crypto.randomUUID();
  private readonly staleLockMs: number;
  private readonly heartbeatStaleMs: number;
  private readonly probe: LockLivenessProbe;
  private readonly now: () => number;
  /** Last heartbeat ts written into the lock (throttle window anchor). */
  private lastHeartbeatAt = 0;
  private nextSeq: number;
  private closed = false;
  private chain: Promise<void> = Promise.resolve();

  private constructor(
    sessionDir: string,
    private readonly sessionId: string,
    startSeq: number,
    options: SessionLogWriterOptions,
  ) {
    this.eventsPath = path.join(sessionDir, 'events.jsonl');
    this.lockPath = path.join(sessionDir, 'writer.lock');
    this.nextSeq = startSeq;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.heartbeatStaleMs = options.heartbeatStaleMs ?? resolveHeartbeatStaleMs();
    this.probe = options.probe ?? defaultLockLivenessProbe;
    this.now = options.now ?? Date.now;
  }

  /** Create the writer and acquire the ownership lock. */
  static async open(
    sessionDir: string,
    sessionId: string,
    startSeq = 1,
    options: SessionLogWriterOptions = {},
  ): Promise<SessionLogWriter> {
    const writer = new SessionLogWriter(sessionDir, sessionId, startSeq, options);
    await fs.mkdir(sessionDir, { recursive: true });
    await writer.acquireLock();
    return writer;
  }

  get path(): string {
    return this.eventsPath;
  }

  get currentSeq(): number {
    return this.nextSeq - 1;
  }

  private lockPayload(): string {
    return JSON.stringify({ ownership: this.ownership, pid: process.pid, ts: this.now() });
  }

  private async acquireLock(): Promise<void> {
    const payload = this.lockPayload();
    try {
      await fs.writeFile(this.lockPath, payload, { encoding: 'utf-8', flag: 'wx', mode: 0o644 });
      this.lastHeartbeatAt = this.now();
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const existing = await fs.readFile(this.lockPath, 'utf-8').catch(() => null);
    let owner = 'unknown';
    const lockInfo: LockInfo = {};
    if (existing) {
      try {
        const parsed = JSON.parse(existing) as LockInfo;
        owner = parsed.ownership ?? owner;
        lockInfo.ownership = parsed.ownership;
        lockInfo.pid = parsed.pid;
        lockInfo.ts = parsed.ts;
      } catch {
        // Corrupt lock file — no usable pid/ts; the legacy staleness rule decides.
      }
    }
    const verdict = evaluateLockTakeover(lockInfo, {
      now: this.now(),
      probe: this.probe,
      heartbeatStaleMs: this.heartbeatStaleMs,
      staleLockMs: this.staleLockMs,
    });
    if (!verdict.takeover) throw new SessionLogLockedError(this.eventsPath, owner);
    await fs.writeFile(this.lockPath, payload, { encoding: 'utf-8' });
    this.lastHeartbeatAt = this.now();
  }

  /** Min interval between lock-ts refreshes (≤ ~1 rewrite/second). */
  private static readonly HEARTBEAT_MIN_INTERVAL_MS = 1000;

  /**
   * Lock heartbeat: while we own the lock, refresh its ts so concurrent
   * writers can tell a live owner from a hung one. Best-effort and throttled
   * to at most ~1 rewrite/second; it rides the append chain so close() always
   * lands AFTER the last heartbeat (never resurrects a removed lock).
   */
  private maybeHeartbeat(): void {
    const ts = this.now();
    if (ts - this.lastHeartbeatAt < SessionLogWriter.HEARTBEAT_MIN_INTERVAL_MS) return;
    this.lastHeartbeatAt = ts;
    void fs.writeFile(this.lockPath, this.lockPayload(), { encoding: 'utf-8' }).catch(() => {
      /* best-effort — a lost refresh is retried after the throttle window */
    });
  }

  /** Append one event; returns the validated envelope with its assigned seq. */
  async append(input: SessionEventInput): Promise<SessionEventEnvelope> {
    if (this.closed) throw new Error(`SessionLogWriter is closed (${this.eventsPath})`);
    const envelope: SessionEventEnvelope = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      sessionId: this.sessionId,
      seq: this.nextSeq,
      ts: this.now(),
      kind: input.kind,
      actor: input.actor,
      data: input.data ?? {},
    };
    SessionEventEnvelopeSchema.parse(envelope);
    this.nextSeq += 1;
    this.chain = this.chain.then(() => this.maybeHeartbeat());
    const line = JSON.stringify(envelope) + '\n';
    this.chain = this.chain.then(() => fs.appendFile(this.eventsPath, line, 'utf-8'));
    await this.chain;
    return envelope;
  }

  /** Flush pending appends, mark closed, release the ownership lock. */
  async close(): Promise<void> {
    await this.chain;
    this.closed = true;
    await fs.rm(this.lockPath, { force: true });
  }
}
