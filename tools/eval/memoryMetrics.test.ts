import { describe, expect, it } from 'vitest';
import { evaluateMemoryRecall, semanticGain, type MemoryEvalCase } from './memoryMetrics.ts';

const cases: MemoryEvalCase[] = [
  { id: 'restart-decision', relevantIds: ['sqlite-decision'] },
  { id: 'unrelated', relevantIds: [] },
  { id: 'supersession', relevantIds: ['sqlite-decision'], forbiddenIds: ['jsonl-decision'] },
  { id: 'tentacle-transfer', relevantIds: ['shared-constraint'] },
  { id: 'failure-root-cause', relevantIds: ['wal-lock-root-cause'] },
];

describe('memory evaluation metrics', () => {
  it('makes semantic quality gains and stale injection mechanically gateable', () => {
    const lexical = evaluateMemoryRecall(cases, [
      { caseId: 'restart-decision', returnedIds: ['sqlite-decision'], contextTokens: 80, latencyMs: 12 },
      { caseId: 'unrelated', returnedIds: [], contextTokens: 0, latencyMs: 8 },
      { caseId: 'supersession', returnedIds: ['sqlite-decision'], contextTokens: 75, latencyMs: 11 },
      { caseId: 'tentacle-transfer', returnedIds: [], contextTokens: 0, latencyMs: 9 },
      { caseId: 'failure-root-cause', returnedIds: [], contextTokens: 0, latencyMs: 13 },
    ]);
    const hybrid = evaluateMemoryRecall(cases, [
      { caseId: 'restart-decision', returnedIds: ['sqlite-decision'], contextTokens: 80, latencyMs: 20 },
      { caseId: 'unrelated', returnedIds: [], contextTokens: 0, latencyMs: 16 },
      { caseId: 'supersession', returnedIds: ['sqlite-decision'], contextTokens: 75, latencyMs: 18 },
      { caseId: 'tentacle-transfer', returnedIds: ['shared-constraint'], contextTokens: 65, latencyMs: 17 },
      { caseId: 'failure-root-cause', returnedIds: ['wal-lock-root-cause'], contextTokens: 70, latencyMs: 21 },
    ]);
    expect(semanticGain(lexical, hybrid)).toMatchObject({ materiallyBetter: true });
    expect(hybrid.recallAtK).toBe(1);
    expect(hybrid.precisionAtK).toBe(1);
    expect(hybrid.staleInjectionRate).toBe(0);
    expect(hybrid.duplicateRate).toBe(0);
    expect(hybrid.latencyP95Ms).toBe(21);
    expect(hybrid.usefulMemoriesPer1kTokens).toBeGreaterThan(10);
  });

  it('penalizes superseded and duplicate injection', () => {
    const metrics = evaluateMemoryRecall(
      [{ id: 'supersession', relevantIds: ['new'], forbiddenIds: ['old'] }],
      [{ caseId: 'supersession', returnedIds: ['old', 'new', 'new'], contextTokens: 100, latencyMs: 4 }],
    );
    expect(metrics.staleInjectionRate).toBeCloseTo(1 / 3);
    expect(metrics.duplicateRate).toBeCloseTo(1 / 3);
    expect(metrics.precisionAtK).toBeCloseTo(1 / 3);
  });
});
