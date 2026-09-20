/**
 * eval-armsUnverifiedMetric.test.ts — WS7 slice 0: the per-arm honesty metric.
 *
 * `unverifiedVerifications` counts real `verification_run` events carrying the
 * M1.2 `unverified: true` marker (strict done ON, nothing evaluable — the
 * "narration-only done" honesty marker, P1: unknown ≠ pass). It is COUNTED
 * from the stream, never inferred: 0 until the marker appears, exactly like
 * the other §89 fields in metrics.ts.
 */
import { describe, expect, it } from 'vitest';
import { metricsFromNdjson, zeroMetrics } from '../../tools/eval/arms/metrics.ts';
import { aggregateByArm } from '../../tools/eval/arms/reporter.ts';
import type { ArmRunRecord } from '../../tools/eval/arms/types.ts';

describe('ArmRunMetrics.unverifiedVerifications', () => {
  it('starts at 0 (the field exists before any event does)', () => {
    expect(zeroMetrics().unverifiedVerifications).toBe(0);
    expect(metricsFromNdjson([], true).unverifiedVerifications).toBe(0);
  });

  it('counts only verification_run events that carry the unverified marker', () => {
    const lines = [
      JSON.stringify({ type: 'verification_run', verdict: 'PASS', legacy: { total: 3 } }),
      JSON.stringify({ type: 'verification_run', verdict: 'PASS', unverified: true }),
      JSON.stringify({ type: 'verification_run', unverified: false }),
      JSON.stringify({ type: 'verification_run', unverified: true }),
    ];
    expect(metricsFromNdjson(lines, true).unverifiedVerifications).toBe(2);
  });

  it('tolerates garbage lines without inventing a count', () => {
    expect(metricsFromNdjson(['not json', '{"type":"verification_run"}'], true).unverifiedVerifications).toBe(0);
  });

  it('surfaces as a per-arm rate in the comparison aggregate', () => {
    const run = (armId: string, unverified: number): ArmRunRecord => ({
      armId,
      caseId: 'c1',
      metrics: { ...zeroMetrics(), unverifiedVerifications: unverified },
      ndjsonLines: 1,
    });
    const aggs = aggregateByArm([run('a', 0), run('a', 1), run('b', 0)]);
    expect(aggs.find((x) => x.armId === 'a')?.unverifiedRate).toBe(0.5);
    expect(aggs.find((x) => x.armId === 'b')?.unverifiedRate).toBe(0);
  });
});
