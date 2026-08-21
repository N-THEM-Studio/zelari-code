import { describe, expect, it } from 'vitest';
import { deriveMessages } from './modelSurface.js';
import {
  buildCompactionStateSnapshot,
  coveringCompactions,
  formatCompactionStateSnapshot,
  parseCompactedEvent,
} from './compaction.js';
import { validateSessionTrace } from './invariants.js';
import type { SessionEventEnvelope, SessionEventKind } from './types.js';

function e(seq: number, kind: SessionEventKind, data: Record<string, unknown> = {}): SessionEventEnvelope {
  return { schemaVersion: 1, sessionId: 's', seq, ts: seq, kind, actor: { type: 'system' }, data };
}

function turns(from: number, to: number): SessionEventEnvelope[] {
  const out: SessionEventEnvelope[] = [];
  for (let s = from; s <= to; s++) {
    out.push(e(s, s % 2 === 1 ? 'user.message' : 'assistant.message', { text: `m${s}` }));
  }
  return out;
}

describe('parseCompactedEvent', () => {
  it('ignores legacy summary-only compact events', () => {
    expect(parseCompactedEvent(e(7, 'session.compacted', { summary: 'early' }))).toBeNull();
  });

  it('parses a range-bearing checkpoint', () => {
    const c = parseCompactedEvent(
      e(101, 'session.compacted', {
        fromSeq: 1,
        toSeq: 100,
        checkpoint: { role: 'user', content: 'C1' },
        strategy: 'llm',
        sourceEventSeqs: [1, 50, 100],
      }),
    );
    expect(c).toMatchObject({ seq: 101, fromSeq: 1, toSeq: 100, role: 'user', content: 'C1', strategy: 'llm' });
  });
});

describe('compaction state snapshot', () => {
  it('retains criteria, evidence, failures, constraints, files and mission phase', () => {
    const events = [
      e(1, 'user.message', { text: 'You must not change the public API.' }),
      e(2, 'tool.call', { callId: 'c1', tool: 'edit_file', args: { path: 'src/core/api.ts' } }),
      e(3, 'verification.evidence', { path: 'src/core/api.ts', digest: 'abc' }),
      e(4, 'verification.run', {
        verdict: 'BLOCKED',
        summary: 'typecheck still fails',
        evidence: {
          satisfied: [],
          unsatisfied: [{ id: 'typecheck', status: 'fail', reason: 'TS error' }],
        },
        native: {
          criteria: [{ id: 'typecheck', required: true }],
          results: [
            {
              criterionId: 'typecheck',
              status: 'fail',
              evidence: [
                { seq: 3, tier: 'command-output', ref: 'npm run typecheck', digest: 'abc' },
              ],
            },
          ],
        },
      }),
      e(5, 'mission.phase', { phase: 'verification' }),
    ];
    const snapshot = buildCompactionStateSnapshot(events, 5);
    expect(snapshot.activeCriteria).toEqual([
      { id: 'typecheck', required: true, status: 'fail' },
    ]);
    expect(snapshot.unresolvedIssues).toEqual([
      { id: 'typecheck', status: 'fail', reason: 'TS error' },
    ]);
    expect(snapshot.retainedEvidenceRefs[0]).toMatchObject({ seq: 3, digest: 'abc' });
    expect(snapshot.affectedFiles).toContain('src/core/api.ts');
    expect(snapshot.userConstraints).toContain('You must not change the public API.');
    expect(snapshot.missionState?.phase).toBe('verification');
    expect(formatCompactionStateSnapshot(snapshot)).toContain('activeCriteria');
  });
});


describe('deriveMessages durable shadowing', () => {
  it('17.1 basic: C1 shadows 1..100, keeps 101+', () => {
    const events = [
      ...turns(1, 4),
      e(5, 'session.compacted', {
        fromSeq: 1,
        toSeq: 4,
        checkpoint: { role: 'system', content: 'C1' },
      }),
      e(6, 'user.message', { text: 'after' }),
      e(7, 'assistant.message', { text: 'ok' }),
    ];
    const messages = deriveMessages(events);
    expect(messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      'system:C1',
      'user:after',
      'assistant:ok',
    ]);
  });

  it('17.2 nested: C2 1..180 swallows C1', () => {
    const events = [
      ...turns(1, 4),
      e(5, 'session.compacted', {
        fromSeq: 1,
        toSeq: 4,
        checkpoint: { role: 'system', content: 'C1' },
      }),
      e(6, 'user.message', { text: 'mid' }),
      e(7, 'session.compacted', {
        fromSeq: 1,
        toSeq: 6,
        checkpoint: { role: 'system', content: 'C2' },
      }),
      e(8, 'user.message', { text: 'tail' }),
    ];
    const messages = deriveMessages(events);
    expect(messages.map((m) => `${m.role}:${m.content}`)).toEqual(['system:C2', 'user:tail']);
    expect(coveringCompactions(events).map((c) => c.content)).toEqual(['C2']);
  });
  it('transitively inherits the raw range when C2 only covers the C1 checkpoint seq', () => {
    const events = [
      ...turns(1, 4),
      e(5, 'session.compacted', {
        fromSeq: 1,
        toSeq: 4,
        checkpoint: { role: 'system', content: 'C1' },
      }),
      e(6, 'user.message', { text: 'mid' }),
      e(7, 'session.compacted', {
        fromSeq: 5,
        toSeq: 6,
        checkpoint: { role: 'system', content: 'C2' },
      }),
      e(8, 'user.message', { text: 'tail' }),
    ];
    const coverings = coveringCompactions(events);
    expect(coverings).toMatchObject([{ seq: 7, fromSeq: 1, toSeq: 6, content: 'C2' }]);
    const messages = deriveMessages(events);
    expect(messages.map((m) => m.content)).toEqual(['C2', 'tail']);
    expect(messages[0]).toMatchObject({ compactedFromSeq: 1, compactedToSeq: 6 });
  });

  it('17.3 partial: C1 = 20..100 keeps 1..19', () => {
    const events = [
      e(1, 'user.message', { text: 'keep-1' }),
      e(2, 'assistant.message', { text: 'keep-2' }),
      e(3, 'user.message', { text: 'shadow' }),
      e(4, 'assistant.message', { text: 'shadow-a' }),
      e(5, 'session.compacted', {
        fromSeq: 3,
        toSeq: 4,
        checkpoint: { role: 'system', content: 'C1' },
      }),
      e(6, 'user.message', { text: 'after' }),
    ];
    expect(deriveMessages(events).map((m) => `${m.role}:${m.content}`)).toEqual([
      'user:keep-1',
      'assistant:keep-2',
      'system:C1',
      'user:after',
    ]);
  });

  it('17.6 idempotence: derive N times is the same surface', () => {
    const events = [
      ...turns(1, 4),
      e(5, 'session.compacted', {
        fromSeq: 1,
        toSeq: 4,
        checkpoint: { role: 'system', content: 'C1' },
      }),
      e(6, 'user.message', { text: 'after' }),
    ];
    const first = deriveMessages(events);
    for (let i = 0; i < 10; i++) {
      expect(deriveMessages(events)).toEqual(first);
    }
  });
});

describe('compaction invariants', () => {
  it('17.4 rejects a tool-call/result split across the compact boundary', () => {
    const v = validateSessionTrace(
      [
        e(1, 'tool.call', { callId: 'c1', tool: 'bash' }),
        e(2, 'session.compacted', {
          fromSeq: 1,
          toSeq: 1,
          checkpoint: { role: 'system', content: 'C1' },
        }),
        e(3, 'tool.result', { callId: 'c1', ok: true, output: 'ok' }),
      ],
      'minimal',
    );
    expect(v.some((x) => x.code === 'COMPACTION_TOOL_PAIR_SPLIT')).toBe(true);
  });
  it('rejects the reverse split when the result is inside but its call is outside', () => {
    const v = validateSessionTrace(
      [
        e(1, 'tool.call', { callId: 'c1', tool: 'bash' }),
        e(2, 'tool.result', { callId: 'c1', ok: true, output: 'ok' }),
        e(3, 'session.compacted', {
          fromSeq: 2,
          toSeq: 2,
          checkpoint: { role: 'system', content: 'C1' },
        }),
      ],
      'minimal',
    );
    expect(v.some((x) => x.code === 'COMPACTION_TOOL_PAIR_SPLIT')).toBe(true);
  });

  it('rejects compacting a tool call that is still active', () => {
    const v = validateSessionTrace(
      [
        e(1, 'tool.call', { callId: 'c1', tool: 'bash' }),
        e(2, 'session.compacted', {
          fromSeq: 1,
          toSeq: 1,
          checkpoint: { role: 'system', content: 'C1' },
        }),
      ],
      'minimal',
    );
    expect(v.some((x) => x.code === 'COMPACTION_ACTIVE_TOOL_CALL')).toBe(true);
  });

  it('accepts a compact that keeps the tool pair inside the range', () => {
    const events = [
      e(1, 'tool.call', { callId: 'c1', tool: 'bash' }),
      e(2, 'tool.result', { callId: 'c1', ok: true, output: 'ok' }),
      e(3, 'session.compacted', {
        fromSeq: 1,
        toSeq: 2,
        checkpoint: { role: 'system', content: 'C1' },
      }),
    ];
    expect(validateSessionTrace(events, 'strict').filter((x) => x.code.startsWith('COMPACTION'))).toEqual([]);
    expect(deriveMessages(events).map((m) => m.content)).toEqual(['C1']);
  });

  it('flags compact event inside its own range', () => {
    const v = validateSessionTrace(
      [
        e(1, 'user.message', { text: 'x' }),
        e(2, 'session.compacted', { fromSeq: 1, toSeq: 2, summary: 'bad' }),
      ],
      'minimal',
    );
    expect(v.some((x) => x.code === 'COMPACTION_EVENT_INSIDE_RANGE')).toBe(true);
  });
});
