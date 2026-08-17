/**
 * observationStore — addressable evidence from the append-only session log.
 * 2026-07 context-growth plan, Fase 2.
 *
 * The session JSONL is the source of truth. Each `tool_execution_end` event
 * gets a 1-based monotonic `seq` (order of appearance in the file). The
 * model-facing surface stores only `OBSERVATION ref=#N`; this module
 * rematerializes `#N` on demand.
 *
 * Lookups are cached per process + session file mtime so retrieve_observation
 * and the surface projector stay cheap. The cache is NEVER written back into
 * the JSONL (log stays immutable).
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { readSession } from '@zelari/core/harness';
import type { BrainEvent, BrainToolExecutionEndEvent } from '@zelari/core/events';
import { getSessionBaseDir, getCurrentSessionId } from '../sessionManager.js';
import type { AgentMessage } from '@zelari/core/harness';
import { projectSessionSurface, sessionSurfaceEnabled } from './sessionSurface.js';

export interface ObservationRecord {
  /** 1-based index among tool_execution_end events in the session file. */
  seq: number;
  toolCallId: string;
  /** Tool name, recovered from the matching tool_execution_start when present. */
  toolName?: string;
  result: string;
  isError: boolean;
  durationMs: number;
  eventId: string;
  ts: number;
}

interface SessionIndex {
  filePath: string;
  mtimeMs: number;
  bySeq: Map<number, ObservationRecord>;
  byToolCallId: Map<string, number>;
  names: Map<string, string>;
}

const cache = new Map<string, SessionIndex>();

function sessionFilePath(sessionId: string, baseDir?: string): string {
  return path.join(baseDir ?? getSessionBaseDir(), `${sessionId}.jsonl`);
}

function isToolEnd(e: BrainEvent): e is BrainToolExecutionEndEvent {
  return e.type === 'tool_execution_end';
}

function isToolStart(
  e: BrainEvent,
): e is BrainEvent & { type: 'tool_execution_start'; toolCallId: string; toolName: string } {
  return e.type === 'tool_execution_start';
}

/** Build (or reuse) the seq index for a session JSONL. */
export async function loadObservationIndex(
  sessionId: string,
  baseDir?: string,
): Promise<SessionIndex> {
  const filePath = sessionFilePath(sessionId, baseDir);
  const exists = existsSync(filePath);
  let mtimeMs = 0;
  if (exists) {
    try {
      mtimeMs = statSync(filePath).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
  }
  const hit = cache.get(sessionId);
  // Live ingest / tests may populate the cache before any JSONL exists.
  if (hit && !exists) return hit;
  if (hit && hit.filePath === filePath && hit.mtimeMs === mtimeMs) return hit;

  const events = existsSync(filePath) ? await readSession(filePath) : [];
  const names = new Map<string, string>();
  const bySeq = new Map<number, ObservationRecord>();
  const byToolCallId = new Map<string, number>();
  let seq = 0;
  for (const e of events) {
    if (isToolStart(e)) {
      names.set(e.toolCallId, e.toolName);
      continue;
    }
    if (!isToolEnd(e)) continue;
    seq += 1;
    const rec: ObservationRecord = {
      seq,
      toolCallId: e.toolCallId,
      toolName: names.get(e.toolCallId),
      result: e.result,
      isError: e.isError,
      durationMs: e.durationMs,
      eventId: e.id,
      ts: e.ts,
    };
    bySeq.set(seq, rec);
    if (e.toolCallId) byToolCallId.set(e.toolCallId, seq);
  }
  const index: SessionIndex = { filePath, mtimeMs, bySeq, byToolCallId, names };
  cache.set(sessionId, index);
  return index;
}

/** Drop a cached index (tests / /new). */
export function invalidateObservationIndex(sessionId?: string): void {
  if (sessionId) cache.delete(sessionId);
  else cache.clear();
}

export async function getObservationBySeq(
  sessionId: string,
  seq: number,
  baseDir?: string,
): Promise<ObservationRecord | undefined> {
  const index = await loadObservationIndex(sessionId, baseDir);
  return index.bySeq.get(seq);
}

export async function getSeqForToolCallId(
  sessionId: string,
  toolCallId: string,
  baseDir?: string,
): Promise<number | undefined> {
  const index = await loadObservationIndex(sessionId, baseDir);
  return index.byToolCallId.get(toolCallId);
}

/**
 * Sync lookup used by the projector on the request path.
 * Returns undefined when the session file is missing or the id is unknown
 * (offline tests, first turn before flush). Caller falls back to ordinal.
 */
export function lookupSeqSync(
  sessionId: string,
  toolCallId: string,
  baseDir?: string,
): number | undefined {
  const filePath = sessionFilePath(sessionId, baseDir);
  const hit = cache.get(sessionId);
  if (hit && hit.filePath === filePath) return hit.byToolCallId.get(toolCallId);
  return undefined;
}

/** Number of indexed observations (0 if uncached / empty). */
export function indexedObservationCount(sessionId: string): number {
  return cache.get(sessionId)?.bySeq.size ?? 0;
}

/**
 * Warm the cache from an in-memory event list (tests + after flush).
 * Does not touch disk.
 */
export function indexEventsForTests(sessionId: string, events: readonly BrainEvent[]): void {
  const names = new Map<string, string>();
  const bySeq = new Map<number, ObservationRecord>();
  const byToolCallId = new Map<string, number>();
  let seq = 0;
  for (const e of events) {
    if (isToolStart(e)) {
      names.set(e.toolCallId, e.toolName);
      continue;
    }
    if (!isToolEnd(e)) continue;
    seq += 1;
    const rec: ObservationRecord = {
      seq,
      toolCallId: e.toolCallId,
      toolName: names.get(e.toolCallId),
      result: e.result,
      isError: e.isError,
      durationMs: e.durationMs,
      eventId: e.id,
      ts: e.ts,
    };
    bySeq.set(seq, rec);
    if (e.toolCallId) byToolCallId.set(e.toolCallId, seq);
  }
  cache.set(sessionId, {
    filePath: sessionFilePath(sessionId),
    mtimeMs: Date.now(),
    bySeq,
    byToolCallId,
    names,
  });
}

function emptyIndex(sessionId: string, baseDir?: string): SessionIndex {
  return {
    filePath: sessionFilePath(sessionId, baseDir),
    mtimeMs: 0,
    bySeq: new Map(),
    byToolCallId: new Map(),
    names: new Map(),
  };
}

/**
 * Fold a live BrainEvent into the in-memory index (no disk wait).
 * Used on the chat-loop hot path so retrieve_observation works in the
 * same turn the event was emitted, before the JSONL flush lands.
 */
export function ingestLiveEvent(sessionId: string, event: BrainEvent, baseDir?: string): void {
  if (!sessionId) return;
  let index = cache.get(sessionId);
  if (!index) {
    index = emptyIndex(sessionId, baseDir);
    cache.set(sessionId, index);
  }
  if (isToolStart(event)) {
    index.names.set(event.toolCallId, event.toolName);
    return;
  }
  if (!isToolEnd(event)) return;
  if (index.byToolCallId.has(event.toolCallId)) return; // idempotent
  const seq = index.bySeq.size + 1;
  const rec: ObservationRecord = {
    seq,
    toolCallId: event.toolCallId,
    toolName: index.names.get(event.toolCallId),
    result: event.result,
    isError: event.isError,
    durationMs: event.durationMs,
    eventId: event.id,
    ts: event.ts,
  };
  index.bySeq.set(seq, rec);
  index.byToolCallId.set(event.toolCallId, seq);
}

/**
 * Project the current history onto the model-facing surface.
 * Uses the current session id (if any) for stable seq lookup.
 */
export function applySessionSurface(messages: readonly AgentMessage[]): AgentMessage[] {
  if (!sessionSurfaceEnabled()) return messages as AgentMessage[];
  const sid = getCurrentSessionId();
  const lookup = sid ? (id: string) => lookupSeqSync(sid, id) : undefined;
  return projectSessionSurface(messages, undefined, lookup).messages;
}

/** Warm the JSONL index, then project (async request path). */
export async function applySessionSurfaceAsync(
  messages: readonly AgentMessage[],
): Promise<AgentMessage[]> {
  if (!sessionSurfaceEnabled()) return messages as AgentMessage[];
  const sid = getCurrentSessionId();
  if (sid) {
    try {
      await loadObservationIndex(sid);
    } catch {
      // Projection still works with ordinal seq fallback.
    }
  }
  return applySessionSurface(messages);
}
