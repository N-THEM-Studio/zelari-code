import { describe, expect, it } from 'vitest';
import {
  noteBudgetProjection,
  policyFromOccupancy,
  recordFromBudget,
} from './contextProjection.js';

describe('policyFromOccupancy', () => {
  it('maps default thresholds', () => {
    expect(policyFromOccupancy(0)).toBe('ok');
    expect(policyFromOccupancy(0.69)).toBe('ok');
    expect(policyFromOccupancy(0.7)).toBe('warn');
    expect(policyFromOccupancy(0.84)).toBe('warn');
    expect(policyFromOccupancy(0.85)).toBe('compact');
    expect(policyFromOccupancy(0.94)).toBe('compact');
    expect(policyFromOccupancy(0.95)).toBe('hard');
    expect(policyFromOccupancy(1)).toBe('hard');
  });
});

describe('recordFromBudget', () => {
  it('copies occupancy/token fields and derives policy; omits absent pressure', () => {
    const rec = recordFromBudget({
      occupancy: 0.42,
      estimatedHistoryTokens: 8000,
      contextLimit: 32_000,
    });
    expect(rec).toEqual({
      occupancy: 0.42,
      estimatedHistoryTokens: 8000,
      contextLimit: 32_000,
      policy: 'ok',
    });
    expect(rec.contextPressureTokens).toBeUndefined();
  });

  it('keeps contextPressureTokens when present', () => {
    const rec = recordFromBudget({
      occupancy: 0.9,
      estimatedHistoryTokens: 9000,
      contextLimit: 10_000,
      contextPressureTokens: 9100,
    });
    expect(rec.policy).toBe('compact');
    expect(rec.contextPressureTokens).toBe(9100);
  });
});

describe('noteBudgetProjection', () => {
  it('writes a context.projection note with occupancy/policy/token only', () => {
    const notes: Array<{ text: string; data?: Record<string, unknown> }> = [];
    noteBudgetProjection(
      { note: (text, data) => void notes.push({ text, data }) },
      {
        occupancy: 0.42,
        estimatedHistoryTokens: 8000,
        contextLimit: 32_000,
        policy: 'ok',
      },
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toBe('context.projection');
    expect(notes[0]!.data).toEqual({
      subject: 'context.projection',
      occupancy: 0.42,
      estimatedHistoryTokens: 8000,
      contextLimit: 32_000,
      policy: 'ok',
    });
    expect(notes[0]!.data).not.toHaveProperty('contextChars');
  });

  it('swallows a throwing handle', () => {
    expect(() =>
      noteBudgetProjection(
        {
          note: () => {
            throw new Error('spine down');
          },
        },
        { occupancy: 0.1, estimatedHistoryTokens: 1, contextLimit: 10, policy: 'ok' },
      ),
    ).not.toThrow();
  });
});
