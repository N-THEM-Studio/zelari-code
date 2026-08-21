import { afterEach, describe, expect, it } from 'vitest';
import {
  deriveMessages,
  type CompactionStateSnapshot,
  type DerivedMessage,
  type SessionEventEnvelope,
  type SessionEventKind,
} from '@zelari/core/session';
import {
  buildModelContext,
  type CompactionMetrics,
} from '../../src/cli/budget/modelContextBuilder.js';

function event(
  seq: number,
  kind: SessionEventKind,
  data: Record<string, unknown>,
): SessionEventEnvelope {
  return {
    schemaVersion: 1,
    sessionId: 's',
    seq,
    ts: seq,
    kind,
    actor: { type: 'system' },
    data,
  };
}

const originalContextLimit = process.env.ZELARI_CONTEXT_LIMIT;

afterEach(() => {
  if (originalContextLimit === undefined) delete process.env.ZELARI_CONTEXT_LIMIT;
  else process.env.ZELARI_CONTEXT_LIMIT = originalContextLimit;
});

describe('ModelContextBuilder', () => {
  it('prefers the session-derived surface over fallback history', async () => {
    const session = {
      status: 'active',
      derivedPriorTurns: async (): Promise<DerivedMessage[]> => [
        { role: 'user', content: 'from-spine', seq: 3 },
      ],
    };
    const result = await buildModelContext({
      fallbackHistory: [{ role: 'user', content: 'fallback' }],
      session,
      phase: 'build',
      model: 'test-model',
    });
    expect(result.source).toBe('session');
    expect(result.history).toEqual([{ role: 'user', content: 'from-spine', seq: 3 }]);
    expect(result.durableCompaction).toBe(false);
  });

  it('persists, flushes and returns the re-derived durable surface', async () => {
    process.env.ZELARI_CONTEXT_LIMIT = '4000';
    const events: SessionEventEnvelope[] = [];
    for (let seq = 1; seq <= 20; seq++) {
      events.push(
        event(
          seq,
          seq % 2 === 1 ? 'user.message' : 'assistant.message',
          { text: 'm' + seq + '-' + 'x'.repeat(2000) },
        ),
      );
    }
    const snapshot: CompactionStateSnapshot = {
      version: 1,
      activeCriteria: [{ id: 'tests', required: true, status: 'fail' }],
      unresolvedIssues: [{ id: 'tests', status: 'fail' }],
      retainedEvidenceRefs: [],
      affectedFiles: ['src/a.ts'],
      userConstraints: ['Do not change the API'],
    };
    let flushes = 0;
    let payload: Record<string, unknown> | null = null;
    let metric: CompactionMetrics | null = null;
    const session = {
      status: 'active',
      derivedPriorTurns: async () => deriveMessages(events),
      flush: async () => {
        flushes += 1;
      },
      compactionStateSnapshot: async () => snapshot,
    };
    const result = await buildModelContext({
      fallbackHistory: [],
      session,
      phase: 'build',
      model: 'test-model',
      onCompactionMetric: (next) => {
        metric = next;
      },
      persistCompaction: async (next) => {
        payload = next as unknown as Record<string, unknown>;
        events.push(event(21, 'session.compacted', payload));
      },
    });

    expect(result.durableCompaction).toBe(true);
    expect(result.reconstructedFromSession).toBe(true);
    expect(flushes).toBe(1);
    expect(payload).toMatchObject({
      fromSeq: 1,
      checkpoint: { role: 'user' },
      retainedCriterionIds: ['tests'],
      recompactionRate: 0,
      summaryStrategy: 'extractive',
    });
    expect(result.history[0]?.content).toContain('<compaction-state');
    expect(metric).toMatchObject({
      count: 1,
      recompactionRate: 0,
      summaryStrategy: 'extractive',
      restoreFailures: 0,
    });
    expect(result.compactionMetrics).toEqual(metric);
    expect(metric?.savedTokens ?? 0).toBeGreaterThan(0);
    expect(result.history[0]?.compactedFromSeq).toBe(1);
    expect(result.history.some((message) => message.content.startsWith('m1-'))).toBe(false);
  });

  it('reports recompaction and a durable restore failure', async () => {
    process.env.ZELARI_CONTEXT_LIMIT = '4000';
    let persisted = false;
    let metric: CompactionMetrics | null = null;
    const initial: DerivedMessage[] = [
      {
        role: 'system',
        content: 'prior checkpoint ' + 'x'.repeat(2000),
        seq: 20,
        compactedFromSeq: 1,
        compactedToSeq: 10,
      },
    ];
    for (let seq = 21; seq <= 32; seq++) {
      initial.push({
        role: seq % 2 === 1 ? 'user' : 'assistant',
        content: 'turn-' + seq + '-' + 'x'.repeat(2000),
        seq,
      });
    }
    const session = {
      status: 'active',
      derivedPriorTurns: async () => persisted ? null : initial,
      flush: async () => undefined,
    };
    const result = await buildModelContext({
      fallbackHistory: [],
      session,
      phase: 'build',
      model: 'test-model',
      persistCompaction: async () => {
        persisted = true;
      },
      onCompactionMetric: (next) => {
        metric = next;
      },
    });

    expect(result.durableCompaction).toBe(false);
    expect(result.reconstructedFromSession).toBe(false);
    expect(metric).toMatchObject({
      recompactionRate: 1,
      restoreFailures: 1,
    });
    expect(result.compactionMetrics).toEqual(metric);
  });
});
