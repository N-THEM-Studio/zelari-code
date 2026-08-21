/**
 * Relational session invariants (Zelari 2.x workstream C).
 *
 * Shape (Zod envelope) is checked at write/replay time. This module checks
 * relations between events: seq, tool pairing, evidence anchors, order.
 * Production callers should use mode 'minimal'; CI/dev use 'strict'.
 */

import type { SessionEventEnvelope } from './types.js';
import { pairToolCalls } from './modelSurface.js';

export interface SessionInvariantViolation {
  code: string;
  seq?: number;
  message: string;
}

export type SessionInvariantMode = 'minimal' | 'strict';

function asSeq(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function collectEvidenceSeqs(events: readonly SessionEventEnvelope[]): Array<{ ownerSeq: number; refSeq: number }> {
  const out: Array<{ ownerSeq: number; refSeq: number }> = [];
  const walk = (ownerSeq: number, value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(ownerSeq, item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const rec = value as Record<string, unknown>;
    const seq = asSeq(rec.seq);
    if (seq !== undefined && ('digest' in rec || 'tier' in rec || 'ref' in rec)) {
      out.push({ ownerSeq, refSeq: seq });
    }
    for (const v of Object.values(rec)) walk(ownerSeq, v);
  };
  for (const e of events) walk(e.seq, e.data);
  return out;
}

export function validateSessionTrace(
  events: readonly SessionEventEnvelope[],
  mode: SessionInvariantMode = 'minimal',
): SessionInvariantViolation[] {
  const violations: SessionInvariantViolation[] = [];
  let expected = 1;
  for (const e of events) {
    if (e.seq !== expected) {
      violations.push({
        code: 'SEQ_NOT_MONOTONIC',
        seq: e.seq,
        message: `expected seq ${expected}, got ${e.seq}`,
      });
    }
    expected = e.seq + 1;
  }

  const pairs = pairToolCalls(events);
  const resultCounts = new Map<string, number>();
  for (const e of events) {
    if (e.kind !== 'tool.result') continue;
    const callId = typeof e.data.callId === 'string' ? e.data.callId : `seq:${e.seq}`;
    resultCounts.set(callId, (resultCounts.get(callId) ?? 0) + 1);
  }
  for (const [callId, n] of resultCounts) {
    if (n > 1) {
      violations.push({
        code: 'DUPLICATE_TOOL_RESULT',
        message: `callId ${callId} has ${n} tool.result events`,
      });
    }
  }

  const interruptedCallIds = new Set(
    events
      .filter((e) => e.kind === 'tool.interrupted')
      .map((e) => (typeof e.data.callId === 'string' ? e.data.callId : undefined))
      .filter((id): id is string => Boolean(id)),
  );

  for (const pair of pairs) {
    if (pair.result) continue;
    const callId =
      typeof pair.call.data.callId === 'string' ? pair.call.data.callId : `seq:${pair.call.seq}`;
    if (interruptedCallIds.has(callId)) continue;
    if (mode === 'strict') {
      violations.push({
        code: 'DANGLING_TOOL_CALL',
        seq: pair.call.seq,
        message: `tool.call ${callId} has no tool.result and no tool.interrupted`,
      });
    }
  }

  const knownSeq = new Set(events.map((e) => e.seq));
  for (const ref of collectEvidenceSeqs(events)) {
    if (!knownSeq.has(ref.refSeq)) {
      violations.push({
        code: 'EVIDENCE_SEQ_MISSING',
        seq: ref.ownerSeq,
        message: `EvidenceRef.seq ${ref.refSeq} is not an event in this trace`,
      });
    }
  }

  const firstVerification = events.find((e) => e.kind === 'verification.run');
  const firstEnded = events.find((e) => e.kind === 'session.ended');
  if (firstVerification && firstEnded && firstEnded.seq < firstVerification.seq) {
    violations.push({
      code: 'COMPLETION_BEFORE_VERIFICATION',
      seq: firstEnded.seq,
      message: `session.ended seq ${firstEnded.seq} precedes verification.run seq ${firstVerification.seq}`,
    });
  }

  return violations;
}
