import { describe, expect, it } from 'vitest';
import { validateSessionTrace } from './invariants.js';
import type { SessionEventEnvelope, SessionEventKind } from './types.js';

function ev(
  seq: number,
  kind: SessionEventKind,
  data: Record<string, unknown> = {},
  actor: SessionEventEnvelope['actor'] = { type: 'system' },
): SessionEventEnvelope {
  return {
    schemaVersion: 1,
    sessionId: 's',
    seq,
    ts: seq,
    kind,
    actor,
    data,
  };
}

describe('validateSessionTrace', () => {
  it('accepts a paired call/result with monotonic seq', () => {
    const events = [
      ev(1, 'session.started'),
      ev(2, 'user.message', { text: 'hi' }, { type: 'user' }),
      ev(3, 'tool.call', { callId: 'c1', tool: 'read_file' }, { type: 'agent' }),
      ev(4, 'tool.result', { callId: 'c1', ok: true }, { type: 'tool' }),
      ev(5, 'session.ended', { reason: 'completed' }),
    ];
    expect(validateSessionTrace(events, 'strict')).toEqual([]);
  });

  it('flags seq gaps', () => {
    const v = validateSessionTrace([ev(1, 'note'), ev(3, 'note')], 'minimal');
    expect(v.some((x) => x.code === 'SEQ_NOT_MONOTONIC')).toBe(true);
  });

  it('minimal mode allows dangling calls; strict does not', () => {
    const events = [
      ev(1, 'tool.call', { callId: 'c1', tool: 'write_file' }, { type: 'agent' }),
    ];
    expect(validateSessionTrace(events, 'minimal').some((x) => x.code === 'DANGLING_TOOL_CALL')).toBe(
      false,
    );
    expect(validateSessionTrace(events, 'strict').some((x) => x.code === 'DANGLING_TOOL_CALL')).toBe(
      true,
    );
  });

  it('accepts dangling calls classified with tool.interrupted', () => {
    const events = [
      ev(1, 'tool.call', { callId: 'c1', tool: 'write_file' }, { type: 'agent' }),
      ev(2, 'tool.interrupted', {
        callId: 'c1',
        toolCallSeq: 1,
        state: 'started-outcome-unknown',
        retrySafety: 'inspect-first',
      }),
    ];
    expect(validateSessionTrace(events, 'strict')).toEqual([]);
  });

  it('flags duplicate tool.result for the same callId', () => {
    const events = [
      ev(1, 'tool.call', { callId: 'c1', tool: 'bash' }, { type: 'agent' }),
      ev(2, 'tool.result', { callId: 'c1', ok: true }, { type: 'tool' }),
      ev(3, 'tool.result', { callId: 'c1', ok: false }, { type: 'tool' }),
    ];
    expect(
      validateSessionTrace(events, 'minimal').some((x) => x.code === 'DUPLICATE_TOOL_RESULT'),
    ).toBe(true);
  });

  it('flags EvidenceRef.seq that is not in the trace', () => {
    const events = [
      ev(1, 'verification.run', {
        results: [{ criterionId: 't', evidence: [{ tier: 'command-output', seq: 99, digest: 'ab' }] }],
      }),
    ];
    expect(
      validateSessionTrace(events, 'minimal').some((x) => x.code === 'EVIDENCE_SEQ_MISSING'),
    ).toBe(true);
  });

  it('flags session.ended before verification.run', () => {
    const events = [
      ev(1, 'session.ended', { reason: 'completed' }),
      ev(2, 'verification.run', { results: [] }),
    ];
    expect(
      validateSessionTrace(events, 'minimal').some((x) => x.code === 'COMPLETION_BEFORE_VERIFICATION'),
    ).toBe(true);
  });
});
