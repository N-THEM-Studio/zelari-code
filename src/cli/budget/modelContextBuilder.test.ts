import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@zelari/core/harness';
import { buildModelContext } from './modelContextBuilder.js';

const snapshot = {
  toolCallsLimit: 40,
  toolCallsUsed: 3,
  toolCallsRemaining: 37,
  verificationReserve: 6,
  repairReserve: 4,
  stage: 'implement',
  pressure: 'normal',
};

function countStatus(history: readonly AgentMessage[]): number {
  return history.filter(
    (m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('RESOURCE STATUS'),
  ).length;
}

describe('modelContextBuilder ephemeral RESOURCE STATUS tail', () => {
  it('returns one request-only tail without mutating persistent history', async () => {
    const result = await buildModelContext({
      fallbackHistory: [{ role: 'user', content: 'fix the bug' }],
      phase: 'build',
      resourceSnapshot: snapshot,
    });
    expect(countStatus(result.history)).toBe(0);
    expect(countStatus(result.requestTail)).toBe(1);
  });

  it('strips a legacy persisted status and replaces it with the current tail', async () => {
    const result = await buildModelContext({
      fallbackHistory: [
        { role: 'user', content: 'fix the bug' },
        {
          role: 'system',
          content:
            'RESOURCE STATUS\nTool calls: 3 / 40\nRemaining: 37\nVerification reserve: 6\nRepair reserve: 4\nStage: implement\nPressure: normal',
        },
      ],
      phase: 'build',
      resourceSnapshot: snapshot,
    });
    expect(countStatus(result.history)).toBe(0);
    expect(countStatus(result.requestTail)).toBe(1);
    expect(result.requestTail[0]!.content).toContain('Tool calls: 3 / 40');
  });

  it('no snapshot input → no status block at all', async () => {
    const result = await buildModelContext({
      fallbackHistory: [{ role: 'user', content: 'hello' }],
      phase: 'build',
    });
    expect(countStatus(result.history)).toBe(0);
    expect(countStatus(result.requestTail)).toBe(0);
  });
});
