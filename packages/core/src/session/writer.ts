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
  /** Injectable clock for tests. */
  now?: () => number;
}

const DEFAULT_STALE_LOCK_MS = 10 * 60 * 1000;

export class SessionLogWriter {
  private readonly eventsPath: string;
  private readonly lockPath: string;
  private readonly ownership = crypto.randomUUID();
  private readonly staleLockMs: number;
  private readonly now: () => number;
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
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const existing = await fs.readFile(this.lockPath, 'utf-8').catch(() => null);
    let owner = 'unknown';
    let ts = 0;
    if (existing) {
      try {
        const parsed = JSON.parse(existing) as { ownership?: string; ts?: number };
        owner = parsed.ownership ?? owner;
        ts = parsed.ts ?? ts;
      } catch {
        // Corrupt lock file — treat as stale.
      }
    }
    const stale = ts > 0 && this.now() - ts > this.staleLockMs;
    if (!stale) throw new SessionLogLockedError(this.eventsPath, owner);
    await fs.writeFile(this.lockPath, payload, { encoding: 'utf-8' });
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
