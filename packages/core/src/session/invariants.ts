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

  pushCompactionViolations(events, knownSeq, pairs, violations);

  return violations;
}

function pushCompactionViolations(
  events: readonly SessionEventEnvelope[],
  knownSeq: Set<number>,
  pairs: ReturnType<typeof pairToolCalls>,
  violations: SessionInvariantViolation[],
): void {
  for (const e of events) {
    if (e.kind !== 'session.compacted') continue;
    const fromSeq = asSeq(e.data.fromSeq);
    const toSeq = asSeq(e.data.toSeq);
    if (fromSeq === undefined && toSeq === undefined) continue;
    if (fromSeq === undefined || toSeq === undefined || fromSeq > toSeq) {
      violations.push({
        code: 'COMPACTION_RANGE_INVALID',
        seq: e.seq,
        message: `session.compacted seq ${e.seq} has invalid fromSeq/toSeq`,
      });
      continue;
    }
    if (e.seq <= toSeq) {
      violations.push({
        code: 'COMPACTION_EVENT_INSIDE_RANGE',
        seq: e.seq,
        message: `session.compacted seq ${e.seq} must be > toSeq ${toSeq}`,
      });
    }
    if (!knownSeq.has(fromSeq) || !knownSeq.has(toSeq)) {
      violations.push({
        code: 'COMPACTION_BOUNDARY_SEQ_MISSING',
        seq: e.seq,
        message: `session.compacted seq ${e.seq} range endpoints must exist in the trace`,
      });
    }
    const checkpoint = e.data.checkpoint;
    if (
      !checkpoint ||
      typeof checkpoint !== 'object' ||
      !['user', 'system'].includes(String((checkpoint as Record<string, unknown>).role ?? '')) ||
      typeof (checkpoint as Record<string, unknown>).content !== 'string'
    ) {
      violations.push({
        code: 'COMPACTION_CHECKPOINT_INVALID',
        seq: e.seq,
        message: `session.compacted seq ${e.seq} must carry a user/system checkpoint with string content`,
      });
    }
    const sourceRaw = e.data.sourceEventSeqs;
    if (Array.isArray(sourceRaw)) {
      for (const raw of sourceRaw) {
        const s = asSeq(raw);
        if (s === undefined) {
          violations.push({
            code: 'COMPACTION_SOURCE_SEQ_INVALID',
            seq: e.seq,
            message: 'sourceEventSeqs entries must be positive integers',
          });
        } else if (!knownSeq.has(s)) {
          violations.push({
            code: 'COMPACTION_SOURCE_SEQ_MISSING',
            seq: e.seq,
            message: `sourceEventSeqs ${s} is not an event in this trace`,
          });
        } else if (s < fromSeq || s > toSeq) {
          violations.push({
            code: 'COMPACTION_SOURCE_SEQ_OUTSIDE_RANGE',
            seq: e.seq,
            message: `sourceEventSeqs ${s} is outside ${fromSeq}..${toSeq}`,
          });
        }
      }
    }
    for (const pair of pairs) {
      const callSeq = pair.call.seq;
      const callInside = callSeq >= fromSeq && callSeq <= toSeq;
      if (!pair.result) {
        if (callInside) {
          violations.push({
            code: 'COMPACTION_ACTIVE_TOOL_CALL',
            seq: e.seq,
            message: `tool.call seq ${callSeq} is compacted before a result or interruption`,
          });
        }
        continue;
      }
      const resultSeq = pair.result.seq;
      const resultInside = resultSeq >= fromSeq && resultSeq <= toSeq;
      if (callInside !== resultInside) {
        violations.push({
          code: 'COMPACTION_TOOL_PAIR_SPLIT',
          seq: e.seq,
          message: `tool pair ${callSeq}/${resultSeq} is split by range ${fromSeq}..${toSeq}`,
        });
      }
    }
  }
}

/**
 * 2.6 Track A/B relational invariants: resource events + task contract
 * (doc section 24.1). Standalone so replay/CI can opt in per surface.
 */
export function validateResourceAndContractEvents(
  events: readonly SessionEventEnvelope[],
): SessionInvariantViolation[] {
  const violations: SessionInvariantViolation[] = [];
  let lastToolCallsUsed = -1;
  for (const e of events) {
    if (e.kind === 'resource.snapshot') {
      const used = e.data.toolCallsUsed;
      const remaining = e.data.toolCallsRemaining;
      if (typeof used !== 'number' || typeof remaining !== 'number' || used < 0 || remaining < 0) {
        violations.push({ code: 'RESOURCE_SNAPSHOT_INVALID', seq: e.seq, message: 'snapshot must carry non-negative toolCallsUsed/Remaining' });
        continue;
      }
      if (used < lastToolCallsUsed) {
        violations.push({ code: 'RESOURCE_USED_MONOTONIC', seq: e.seq, message: `toolCallsUsed went ${lastToolCallsUsed} -> ${used}` });
      }
      lastToolCallsUsed = used;
      const limit = typeof e.data.toolCallsLimit === 'number' ? e.data.toolCallsLimit : used + remaining;
      if (used + remaining !== limit) {
        violations.push({ code: 'RESOURCE_REMAINING_COHERENT', seq: e.seq, message: `used(${used}) + remaining(${remaining}) != limit(${limit})` });
      }
      for (const key of ['verificationReserve', 'repairReserve'] as const) {
        const v = e.data[key];
        if (typeof v === 'number' && v < 0) {
          violations.push({ code: 'RESERVE_NEGATIVE', seq: e.seq, message: `${key} is negative (${v})` });
        }
      }
    }
    if (e.kind === 'session.harness_manifest') {
      if (typeof e.data.manifestHash !== 'string' || !e.data.manifest) {
        violations.push({ code: 'MANIFEST_PAYLOAD_INVALID', seq: e.seq, message: 'session.harness_manifest needs {manifest, manifestHash}' });
      }
    }
  }
  let lastVersion = 0;
  for (const e of events) {
    if (e.kind !== 'task.contract' && e.kind !== 'task.contract_updated') continue;
    const contract = e.data.contract;
    const version = contract && typeof contract === 'object' ? (contract as Record<string, unknown>).version : undefined;
    if (typeof version !== 'number' || version < 1) {
      violations.push({ code: 'TASK_CONTRACT_VERSION_MONOTONIC', seq: e.seq, message: 'contract payload must carry a positive version' });
      continue;
    }
    if (version <= lastVersion) {
      violations.push({ code: 'TASK_CONTRACT_VERSION_MONOTONIC', seq: e.seq, message: `version ${version} did not increase past ${lastVersion}` });
    }
    lastVersion = version;
    const source = contract && typeof contract === 'object' ? (contract as Record<string, unknown>).source : undefined;
    const userSeq = source && typeof source === 'object' ? (source as Record<string, unknown>).userSeq : undefined;
    if (typeof userSeq !== 'number' || userSeq < 1) {
      violations.push({ code: 'TASK_CONTRACT_SOURCE_INVALID', seq: e.seq, message: 'contract.source.userSeq must be a positive event seq' });
    }
  }
  return violations;
}
