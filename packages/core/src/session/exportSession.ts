/**
 * session/exportSession.ts — portable, machine-readable session export.
 *
 * The export embeds the full event log plus a compact summary; it requires
 * no lock and is safe to produce from a crashed/interrupted session.
 */

import { buildProjection } from './replay.js';
import type { SessionStore } from './store.js';

export const SESSION_EXPORT_FORMAT = 'zelari-session-export';
export const SESSION_EXPORT_VERSION = 1;

export interface SessionExport {
  format: typeof SESSION_EXPORT_FORMAT;
  version: typeof SESSION_EXPORT_VERSION;
  sessionId: string;
  exportedAt: number;
  summary: {
    lastSeq: number;
    eventCount: number;
    startedAt?: number;
    endedAt?: number;
    forkParent?: string;
    toolCalls: number;
    toolResults: number;
    verifications: number;
    issues: number;
  };
  events: unknown[];
}

export async function exportSession(store: SessionStore, sessionId: string): Promise<SessionExport> {
  const report = await store.read(sessionId);
  const projection = buildProjection(report.events, report.issues);
  return {
    format: SESSION_EXPORT_FORMAT,
    version: SESSION_EXPORT_VERSION,
    sessionId,
    exportedAt: Date.now(),
    summary: {
      lastSeq: projection.lastSeq,
      eventCount: projection.eventCount,
      startedAt: projection.startedAt,
      endedAt: projection.endedAt,
      forkParent: projection.fork?.parentSessionId,
      toolCalls: projection.toolCalls,
      toolResults: projection.toolResults,
      verifications: projection.verifications.length,
      issues: report.issues.length,
    },
    events: report.events,
  };
}

/** Pretty-printed JSON export (headless `--session-export` output). */
export async function exportSessionJson(store: SessionStore, sessionId: string): Promise<string> {
  const exported = await exportSession(store, sessionId);
  return JSON.stringify(exported, null, 2);
}
