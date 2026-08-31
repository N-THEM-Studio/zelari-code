/**
 * retrievalPolicy — budget-aware memory retrieval + skill-catalog gate.
 *
 * Pure CLI-side translation: measured occupancy → recall packing / scoring
 * weights / skill gate (ADR-0031/0032 — the core stays pressure-blind).
 */
import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@zelari/core/harness';
import {
  BASELINE_RETRIEVAL_POLICY,
  estimateHistoryOccupancy,
  filterSkillCatalogByBand,
  resolveRetrievalPolicy,
  retrievalBand,
} from './retrievalPolicy.js';

describe('retrievalPolicy', () => {
  it('low band reproduces the historical fixed call-site budget', () => {
    const policy = resolveRetrievalPolicy(0);
    expect(policy.band).toBe('low');
    expect(policy.maxChars).toBe(BASELINE_RETRIEVAL_POLICY.maxChars);
    expect(policy.maxMemories).toBe(BASELINE_RETRIEVAL_POLICY.maxMemories);
    expect(policy.weights).toBeUndefined();
  });

  it('medium band tightens packing and shifts weights precision-first', () => {
    const policy = resolveRetrievalPolicy(0.6);
    expect(policy.band).toBe('medium');
    expect(policy.maxChars).toBe(1_200);
    expect(policy.maxMemories).toBe(6);
    expect(policy.weights?.recency).toBe(0.05);
    expect(policy.weights?.semanticRelevance).toBeGreaterThan(0.3);
  });

  it('high band minimizes packing and drops recency weight to zero', () => {
    const policy = resolveRetrievalPolicy(0.85);
    expect(policy.band).toBe('high');
    expect(policy.maxChars).toBe(600);
    expect(policy.maxMemories).toBe(4);
    expect(policy.weights?.recency).toBe(0);
  });

  it('clamps out-of-range and non-finite occupancy to a sane band', () => {
    expect(retrievalBand(-1)).toBe('low');
    expect(retrievalBand(2)).toBe('high');
    expect(retrievalBand(Number.NaN)).toBe('low');
  });

  it('estimates history occupancy within (0, 1] via the canonical estimator', () => {
    const tiny: AgentMessage[] = [{ role: 'user', content: 'hello' }];
    const huge: AgentMessage[] = Array.from({ length: 4_000 }, (_, i) => ({
      role: 'user',
      content: `message ${i} `.repeat(50),
    }));
    expect(estimateHistoryOccupancy(tiny)).toBeGreaterThan(0);
    expect(estimateHistoryOccupancy(tiny)).toBeLessThan(1);
    expect(estimateHistoryOccupancy(huge)).toBe(1);
  });

  it('gates only high-cost skills and only under high pressure', () => {
    const skills = [
      { id: 'a', estimatedCost: 'low' },
      { id: 'b', estimatedCost: 'high' },
      { id: 'c' },
    ];
    expect(filterSkillCatalogByBand(skills, 'low')).toHaveLength(3);
    expect(filterSkillCatalogByBand(skills, 'medium')).toHaveLength(3);
    expect(filterSkillCatalogByBand(skills, 'high').map((s) => s.id)).toEqual([
      'a',
      'c',
    ]);
    expect(skills).toHaveLength(3); // input not mutated
  });
});
