/**
 * session/replay.ts — tolerant log reader + projection.
 *
 * Replay never throws on a damaged log: corrupt lines, seq gaps, duplicates
 * and schema mismatches are reported as ReplayIssue so the trajectory can be
 * audited (replay reconstructs the trajectory, not model-output determinism).
 */

import { promises as fs } from 'node:fs';
import {
  SessionEventEnvelopeSchema,
  type SessionEventEnvelope,
} from './types.js';
import { deriveMessages, type DerivedMessage } from './modelSurface.js';

export type ReplayIssueType =
  | 'corrupt-line'
  | 'schema-mismatch'
  | 'seq-duplicate'
  | 'seq-gap'
  | 'seq-nonmonotonic';

export interface ReplayIssue {
  type: ReplayIssueType;
  /** 1-based line number in the JSONL file. */
  line: number;
  seq?: number;
  detail?: string;
}

export interface ReplayReport {
  path: string;
  events: SessionEventEnvelope[];
  issues: ReplayIssue[];
  /** True when every line parsed and seq is 1..n gap-free. */
  ok: boolean;
}

export async function readSessionLog(filePath: string): Promise<ReplayReport> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path: filePath, events: [], issues: [], ok: true };
    }
    throw err;
  }
  const events: SessionEventEnvelope[] = [];
  const issues: ReplayIssue[] = [];
  let expected = 1;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    const lineNo = i + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      issues.push({ type: 'corrupt-line', line: lineNo });
      continue;
    }
    const result = SessionEventEnvelopeSchema.safeParse(parsed);
    if (!result.success) {
      issues.push({
        type: 'schema-mismatch',
        line: lineNo,
        detail: result.error.issues[0]?.message ?? 'schema validation failed',
      });
      continue;
    }
    const envelope = result.data;
    if (envelope.seq === expected) {
      events.push(envelope);
      expected += 1;
    } else if (envelope.seq < expected) {
      issues.push({ type: 'seq-duplicate', line: lineNo, seq: envelope.seq });
    } else {
      issues.push({
        type: 'seq-gap',
        line: lineNo,
        seq: envelope.seq,
        detail: `missing seq ${expected}..${envelope.seq - 1}`,
      });
      events.push(envelope);
      expected = envelope.seq + 1;
    }
  }
  return { path: filePath, events, issues, ok: issues.length === 0 };
}

/** Loose summary of a verification.run event (defensive reads). */
export interface VerificationRunSummary {
  seq: number;
  at: number;
  results: Array<{ criterionId: string; status: string; evidenceCount: number }>;
  complete?: boolean;
}

export interface SessionProjection {
  sessionId: string;
  lastSeq: number;
  eventCount: number;
  startedAt?: number;
  endedAt?: number;
  fork?: { parentSessionId: string; parentSeq: number };
  resumedCount: number;
  messages: DerivedMessage[];
  toolCalls: number;
  toolResults: number;
  verifications: VerificationRunSummary[];
  missionPhases: Array<{ seq: number; phase: string }>;
  /** F4: advisory continuation advice records (mission.progress events). */
  missionAdvice: Array<{ seq: number; recommendation: string; rationale: string }>;
  replans: number;
  issues: ReplayIssue[];
}

function parseVerification(e: SessionEventEnvelope): VerificationRunSummary {
  const raw = Array.isArray(e.data.results) ? e.data.results : [];
  const results = raw
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
    .map((r) => ({
      criterionId: String(r.criterionId ?? 'unknown'),
      status: String(r.status ?? 'unknown'),
      evidenceCount: Array.isArray(r.evidence) ? r.evidence.length : 0,
    }));
  return {
    seq: e.seq,
    at: e.ts,
    results,
    complete: typeof e.data.complete === 'boolean' ? e.data.complete : undefined,
  };
}

/** Build the materialized view of a session from its (valid) events. */
export function buildProjection(events: readonly SessionEventEnvelope[], issues: ReplayIssue[] = []): SessionProjection {
  const last = events[events.length - 1];
  const projection: SessionProjection = {
    sessionId: last?.sessionId ?? '',
    lastSeq: last?.seq ?? 0,
    eventCount: events.length,
    resumedCount: 0,
    messages: deriveMessages(events),
    toolCalls: 0,
    toolResults: 0,
    verifications: [],
    missionPhases: [],
    missionAdvice: [],
    replans: 0,
    issues,
  };
  for (const e of events) {
    switch (e.kind) {
      case 'session.started':
        projection.startedAt = e.ts;
        break;
      case 'session.ended':
        projection.endedAt = e.ts;
        break;
      case 'session.resumed':
        projection.resumedCount += 1;
        break;
      case 'session.forked':
        projection.fork = {
          parentSessionId: String(e.data.parentSessionId ?? ''),
          parentSeq: Number(e.data.parentSeq ?? 0),
        };
        break;
      case 'tool.call':
        projection.toolCalls += 1;
        break;
      case 'tool.result':
        projection.toolResults += 1;
        break;
      case 'verification.run':
        projection.verifications.push(parseVerification(e));
        break;
      case 'mission.phase':
        projection.missionPhases.push({ seq: e.seq, phase: String(e.data.phase ?? '') });
        break;
      case 'mission.replan':
        projection.replans += 1;
        break;
      case 'mission.progress':
        projection.missionAdvice.push({
          seq: e.seq,
          recommendation: String(e.data.recommendation ?? ''),
          rationale: String(e.data.rationale ?? ''),
        });
        break;
        break;
    }
  }
  return projection;
}
