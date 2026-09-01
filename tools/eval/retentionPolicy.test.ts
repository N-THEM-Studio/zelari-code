/**
 * tools/eval/retentionPolicy.test.ts — retention policy schema + presets
 * (2.6 Track A, doc §8.3-8.4). t65 (Fase 0.1): the opt-in `minMeasuredRuns`
 * floor parses as an int >= 1, rejects junk, and NEVER leaks into presets.
 */

import { describe, expect, it } from 'vitest';
import { HarnessRetentionPolicySchema, RETENTION_PRESETS } from './retentionPolicy.ts';

const base = { maxRegressedAnchors: 0, requireValidityPass: true as const };

describe('HarnessRetentionPolicySchema — minMeasuredRuns (t65, Fase 0.1)', () => {
  it('parses with minMeasuredRuns absent (preset shape unchanged)', () => {
    expect(HarnessRetentionPolicySchema.parse(base)).toEqual({
      maxRegressedAnchors: 0,
      requireValidityPass: true,
    });
  });

  it('parses with minMeasuredRuns present (integer >= 1)', () => {
    const policy = HarnessRetentionPolicySchema.parse({ ...base, minMeasuredRuns: 3 });
    expect(policy.minMeasuredRuns).toBe(3);
  });

  it('rejects invalid minMeasuredRuns: 0, 2.5, "3"', () => {
    for (const bad of [0, 2.5, '3']) {
      expect(() => HarnessRetentionPolicySchema.parse({ ...base, minMeasuredRuns: bad })).toThrow();
    }
  });

  it('presets contain no minMeasuredRuns key (opt-in stays unset)', () => {
    for (const preset of Object.values(RETENTION_PRESETS)) {
      expect(Object.keys(preset)).not.toContain('minMeasuredRuns');
    }
  });
});
