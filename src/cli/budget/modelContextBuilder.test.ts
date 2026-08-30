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

describe('modelContextBuilder budget projection seam (T4, ADR-0032)', () => {
  it('projects the final budget onto the optional note handle — occupancy+policy, no memory-side fields', async () => {
    const notes: Array<{ text: string; data?: Record<string, unknown> }> = [];
    const result = await buildModelContext({
      fallbackHistory: [{ role: 'user', content: 'fix the bug' }],
      phase: 'build',
      budgetNoteHandle: { note: (text, data) => void notes.push({ text, data }) },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toBe('context.projection');
    expect(notes[0]!.data).toMatchObject({ subject: 'context.projection' });
    const data = notes[0]!.data as { occupancy?: number; policy?: string };
    expect(typeof data.occupancy).toBe('number');
    expect(['ok', 'warn', 'compact', 'hard']).toContain(data.policy);
    // Budget-side payload must NOT carry the memory-path counters.
    expect(notes[0]!.data).not.toHaveProperty('contextChars');
    expect(notes[0]!.data).not.toHaveProperty('returnedCount');
    // The projection reflects the FINAL budget the caller received.
    expect(data.occupancy).toBe(result.budget.occupancy);
  });

  it('no handle → no note, no crash (backward compatible)', async () => {
    const result = await buildModelContext({
      fallbackHistory: [{ role: 'user', content: 'hello' }],
      phase: 'build',
    });
    expect(result.budget.contextLimit).toBeGreaterThan(0);
  });
});
