import { describe, expect, it } from 'vitest';
import { compactEventPayload, reseedAfterDurableCompact } from '../../src/cli/budget/persistCompact.js';
import type { BudgetPolicy } from '../../src/cli/budget/tokenBudget.js';
import { deriveMessages } from '@zelari/core/session';
import type { SessionEventEnvelope, SessionEventKind } from '@zelari/core/session';

function policy(partial: Partial<BudgetPolicy>): BudgetPolicy {
  return {
    history: [{ role: 'user', content: 'x\n\n<compacted-summary>\nBODY\n</compacted-summary>' }],
    warnings: [],
    maxToolLoopIterations: 10,
    historyTurns: 2,
    estimatedHistoryTokens: 1,
    contextLimit: 1000,
    occupancy: 0.2,
    ...partial,
  };
}

describe('compactEventPayload', () => {
  it('omits the range when the budget has no seqs', () => {
    const p = compactEventPayload(policy({ messagesRemoved: 3, compactSummary: 'BODY' }));
    expect(p.fromSeq).toBeUndefined();
    expect(p.toSeq).toBeUndefined();
    expect(p.summary).toBe('BODY');
  });

  it('includes fromSeq/toSeq/checkpoint when the budget recorded a range', () => {
    const p = compactEventPayload(
      policy({
        messagesRemoved: 4,
        compactSummary: 'BODY',
        compactedFromSeq: 2,
        compactedToSeq: 9,
        compactStrategy: 'extractive',
        compactSourceSeqs: [2, 3, 9],
      }),
    );
    expect(p.fromSeq).toBe(2);
    expect(p.toSeq).toBe(9);
    expect(p.strategy).toBe('extractive');
    expect(p.checkpoint).toMatchObject({ role: 'user' });
    expect(p.checkpoint?.content).toContain('<compacted-summary>');
  });

  it('persists compaction telemetry with the checkpoint', () => {
    const payload = compactEventPayload(
      policy({
        messagesRemoved: 2,
        compactSummary: 'BODY',
        compactedFromSeq: 1,
        compactedToSeq: 3,
        compactStrategy: 'llm',
      }),
      null,
      {
        inputTokens: 900,
        outputTokens: 250,
        savedTokens: 650,
        recompactionRate: 1,
        summaryStrategy: 'llm',
        provider: 'test-provider',
        model: 'test-model',
      },
    );
    expect(payload).toMatchObject({
      inputTokens: 900,
      outputTokens: 250,
      savedTokens: 650,
      recompactionRate: 1,
      summaryStrategy: 'llm',
      provider: 'test-provider',
      model: 'test-model',
    });
  });

  it('combines deterministic state with the narrative checkpoint', () => {
    const payload = compactEventPayload(
      policy({
        messagesRemoved: 2,
        compactSummary: 'BODY',
        compactedFromSeq: 1,
        compactedToSeq: 4,
      }),
      {
        version: 1,
        activeCriteria: [{ id: 'tests', required: true, status: 'fail' }],
        unresolvedIssues: [{ id: 'tests', status: 'fail', reason: 'red' }],
        latestVerification: { seq: 3, verdict: 'BLOCKED' },
        retainedEvidenceRefs: [
          { seq: 2, tier: 'command-output', ref: 'npm test', digest: 'abc' },
        ],
        affectedFiles: ['src/a.ts'],
        userConstraints: ['Do not change the API'],
        missionState: { phase: 'verification' },
      },
    );
    expect(payload.checkpoint?.content).toContain('<compaction-state');
    expect(payload.checkpoint?.content).toContain('<compacted-summary>');
    expect(payload.retainedCriterionIds).toEqual(['tests']);
    expect(payload.retainedEvidenceRefs?.[0]).toMatchObject({ seq: 2 });
    expect(payload.retainedState).toMatchObject({
      unresolvedIssueIds: ['tests'],
      affectedFiles: ['src/a.ts'],
      missionStateRef: 'phase:verification',
    });
  });

});

describe('durable compact then deriveMessages', () => {
  function e(seq: number, kind: SessionEventKind, data: Record<string, unknown>): SessionEventEnvelope {
    return { schemaVersion: 1, sessionId: 's', seq, ts: seq, kind, actor: { type: 'system' }, data };
  }

  it('shadows the dropped range after the compact event is on the log', () => {
    const events = [
      e(1, 'user.message', { text: 'old-a' }),
      e(2, 'assistant.message', { text: 'old-b' }),
      e(3, 'user.message', { text: 'keep' }),
      e(4, 'session.compacted', compactEventPayload(
        policy({
          messagesRemoved: 2,
          compactSummary: 'BODY',
          compactedFromSeq: 1,
          compactedToSeq: 2,
          compactStrategy: 'extractive',
        }),
      ) as unknown as Record<string, unknown>),
    ];
    const messages = deriveMessages(events);
    expect(messages.map((m) => m.role)).toEqual(['user', 'user']);
    expect(messages[0]?.content).toContain('<compacted-summary>');
    expect(messages[1]?.content).toBe('keep');
  });
});

describe('reseedAfterDurableCompact', () => {
  it('strips the current user turn that was logged before compact', async () => {
    const derived = [
      { role: 'user' as const, content: 'checkpoint', seq: 10 },
      { role: 'user' as const, content: 'new prompt', seq: 11 },
    ];
    const seed = await reseedAfterDurableCompact(
      { status: 'active', derivedPriorTurns: async () => derived },
      'new prompt',
    );
    expect(seed?.map((m) => m.content)).toEqual(['checkpoint']);
    expect(seed?.[0]?.seq).toBe(10);
  });
});
