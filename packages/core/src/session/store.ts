/**
 * session/store.ts — session directory management.
 *
 * Default location (ADR-0016 ratification): `<workspaceRoot>/.zelari/sessions/
 * <sessionId>/events.jsonl`, overridable via `ZELARI_SESSIONS_DIR` or the
 * explicit option. The legacy home-level sidecar remains read-only compat.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SessionLogWriter } from './writer.js';
import { buildProjection, readSessionLog, type ReplayReport, type SessionProjection } from './replay.js';
import { ACTOR_SYSTEM, type SessionEventInput } from './types.js';

export interface SessionsDirOptions {
  /** Explicit base dir (tests / Desktop multi-cwd). */
  baseDir?: string;
  /** Workspace root — defaults to process.cwd(). */
  workspaceRoot?: string;
  /** Env override source (defaults to process.env). */
  env?: Record<string, string | undefined>;
}

export function resolveSessionsDir(options: SessionsDirOptions = {}): string {
  if (options.baseDir) return options.baseDir;
  const envDir = options.env?.ZELARI_SESSIONS_DIR ?? process.env.ZELARI_SESSIONS_DIR;
  if (envDir) return envDir;
  const root = options.workspaceRoot ?? process.cwd();
  return path.join(root, '.zelari', 'sessions');
}

export interface SessionCreateOptions {
  reason?: string;
  profile?: string;
  workspace?: string;
}

export interface SessionListEntry {
  sessionId: string;
  lastSeq: number;
  eventCount: number;
  startedAt?: number;
  endedAt?: number;
  forkParent?: string;
}

export class SessionStore {
  constructor(private readonly baseDir: string) {}

  static withDefaults(options: SessionsDirOptions = {}): SessionStore {
    return new SessionStore(resolveSessionsDir(options));
  }

  get dir(): string {
    return this.baseDir;
  }

  sessionDir(sessionId: string): string {
    return path.join(this.baseDir, sessionId);
  }

  eventsPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'events.jsonl');
  }

  /** Create a new session and its writer; appends `session.started`. */
  async create(options: SessionCreateOptions = {}): Promise<{ sessionId: string; writer: SessionLogWriter }> {
    const sessionId = crypto.randomUUID();
    const writer = await SessionLogWriter.open(this.sessionDir(sessionId), sessionId, 1);
    await writer.append({
      kind: 'session.started',
      actor: ACTOR_SYSTEM,
      data: {
        reason: options.reason ?? 'new',
        profile: options.profile,
        workspace: options.workspace,
      },
    });
    return { sessionId, writer };
  }

  /** Replay a session log (tolerant read). */
  async read(sessionId: string): Promise<ReplayReport> {
    return readSessionLog(this.eventsPath(sessionId));
  }

  /** Materialized view of a session. */
  async projection(sessionId: string): Promise<SessionProjection> {
    const report = await this.read(sessionId);
    return buildProjection(report.events, report.issues);
  }

  /** Reopen a session for writing (continues seq after lastSeq). Pure: no event appended. */
  async open(sessionId: string): Promise<{ writer: SessionLogWriter; report: ReplayReport; projection: SessionProjection }> {
    const report = await this.read(sessionId);
    if (report.events.length === 0 && report.issues.length === 0) {
      throw new Error(`Session not found: ${sessionId} (${this.eventsPath(sessionId)})`);
    }
    const lastSeq = report.events[report.events.length - 1]?.seq ?? 0;
    const writer = await SessionLogWriter.open(this.sessionDir(sessionId), sessionId, lastSeq + 1);
    return { writer, report, projection: buildProjection(report.events, report.issues) };
  }

  async exists(sessionId: string): Promise<boolean> {
    try {
      await fs.access(this.eventsPath(sessionId));
      return true;
    } catch {
      return false;
    }
  }

  /** Summaries of all stored sessions (newest first by startedAt). */
  async list(): Promise<SessionListEntry[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.baseDir);
    } catch {
      return [];
    }
    const summaries: SessionListEntry[] = [];
    for (const name of names) {
      const report = await readSessionLog(this.eventsPath(name));
      if (report.events.length === 0 && report.issues.length === 0) continue;
      const projection = buildProjection(report.events);
      summaries.push({
        sessionId: name,
        lastSeq: projection.lastSeq,
        eventCount: projection.eventCount,
        startedAt: projection.startedAt,
        endedAt: projection.endedAt,
        forkParent: projection.fork?.parentSessionId,
      });
    }
    summaries.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    return summaries;
  }

  /** End a session cleanly (appends `session.ended` and releases the writer). */
  async end(writer: SessionLogWriter, reason = 'completed'): Promise<void> {
    const event: SessionEventInput = { kind: 'session.ended', actor: ACTOR_SYSTEM, data: { reason } };
    await writer.append(event);
    await writer.close();
  }
}
