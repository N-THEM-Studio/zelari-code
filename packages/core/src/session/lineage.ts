/**
 * session/lineage.ts — fork / resume on top of the spine.
 *
 * Fork copies the parent trajectory up to `fromSeq` into a NEW session
 * (re-sequenced 1..n; kinds/actors/data preserved verbatim, timestamps
 * re-stamped by the writer) and appends `session.forked {parentSessionId,
 * parentSeq}`. Resume reopens the log and appends `session.resumed`. Resume
 * fidelity is deterministic on the trajectory plane: same events → same
 * projection.
 */

import type { SessionEventEnvelope } from './types.js';
import { ACTOR_SYSTEM } from './types.js';
import { buildProjection, type SessionProjection } from './replay.js';
import type { SessionStore } from './store.js';
import type { SessionLogWriter } from './writer.js';

export interface ForkOptions {
  /** Copy events with seq <= fromSeq (default: all). */
  fromSeq?: number;
  reason?: string;
}

export interface ForkResult {
  sessionId: string;
  writer: SessionLogWriter;
  copiedEvents: number;
}

/** Fork a session into a new one, preserving the trajectory up to fromSeq. */
export async function forkSession(
  store: SessionStore,
  parentSessionId: string,
  options: ForkOptions = {},
): Promise<ForkResult> {
  const parent = await store.read(parentSessionId);
  if (parent.events.length === 0 && parent.issues.length === 0) {
    throw new Error(`Cannot fork — session not found: ${parentSessionId}`);
  }
  const fromSeq = options.fromSeq ?? parent.events[parent.events.length - 1]?.seq ?? 0;
  const copied = parent.events.filter((e) => e.seq <= fromSeq);
  const created = await store.create({ reason: options.reason ?? 'fork' });
  for (const e of copied) {
    await created.writer.append({ kind: e.kind, actor: e.actor, data: e.data });
  }
  await created.writer.append({
    kind: 'session.forked',
    actor: ACTOR_SYSTEM,
    data: { parentSessionId, parentSeq: fromSeq },
  });
  return { sessionId: created.sessionId, writer: created.writer, copiedEvents: copied.length };
}

export interface ResumeResult {
  writer: SessionLogWriter;
  /** Projection including the `session.resumed` marker. */
  projection: SessionProjection;
}

/** Resume a session: reopen the log (seq continues) and mark the resume. */
export async function resumeSession(store: SessionStore, sessionId: string): Promise<ResumeResult> {
  const opened = await store.open(sessionId);
  const resumed = await opened.writer.append({
    kind: 'session.resumed',
    actor: ACTOR_SYSTEM,
    data: { fromSeq: opened.projection.lastSeq },
  });
  const projection = buildProjection([...opened.report.events, resumed]);
  return { writer: opened.writer, projection };
}

/**
 * Ancestor chain of a session (root first). Walks `session.forked` markers
 * across the store; stops on cycles or missing parents.
 */
export async function lineageOf(store: SessionStore, sessionId: string): Promise<string[]> {
  const chain: string[] = [sessionId];
  const seen = new Set<string>([sessionId]);
  let current = sessionId;
  for (let depth = 0; depth < 64; depth++) {
    const report = await store.read(current);
    const forkEvent: SessionEventEnvelope | undefined = [...report.events]
      .reverse()
      .find((e) => e.kind === 'session.forked');
    if (!forkEvent) break;
    const parent = typeof forkEvent.data.parentSessionId === 'string' ? forkEvent.data.parentSessionId : '';
    if (!parent || seen.has(parent)) break;
    if (!(await store.exists(parent))) break;
    chain.unshift(parent);
    seen.add(parent);
    current = parent;
  }
  return chain;
}
