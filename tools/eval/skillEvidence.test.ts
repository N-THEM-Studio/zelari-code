/**
 * tools/eval/skillEvidence.test.ts — Fase 1 — evidence aggregator
 * (report-only, zero mutation). Unit tests over inline records: a skill is
 * flagged only under the threshold rules in skillEvidence.ts; malformed
 * records are counted and skipped, never a crash.
 */

import { describe, expect, it } from 'vitest';
import { aggregateSkillEvidence } from './skillEvidence.ts';

let inv = 0;
function run(skillId: string, ok: boolean): unknown {
  inv += 1;
  return { ts: 1755000000000, skillId, invocationId: `inv-${inv}`, ok };
}

describe('aggregateSkillEvidence', () => {
  it('flags high when success rate < 0.25 at the minRuns threshold', () => {
    const report = aggregateSkillEvidence([run('x', false), run('x', false), run('x', false)]);
    expect(report.recordsScanned).toBe(3);
    expect(report.malformedRecords).toBe(0);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      id: 'skill-low-success:x',
      kind: 'skill-low-success',
      severity: 'high',
      count: 3,
    });
    expect(report.findings[0].detail).toContain('success rate 0.00');
  });

  it('flags warn in the 0.25..<maxSuccessRate band', () => {
    const report = aggregateSkillEvidence([run('y', true), run('y', false), run('y', false)]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ id: 'skill-low-success:y', severity: 'warn', count: 2 });
    expect(report.findings[0].detail).toContain('success rate 0.33');
  });

  it('a rate exactly at maxSuccessRate is NOT flagged (strictly-below rule)', () => {
    const report = aggregateSkillEvidence([
      run('y', true),
      run('y', true),
      run('y', false),
      run('y', false),
    ]);
    expect(report.findings).toEqual([]);
  });

  it('below minRuns the skill is ignored regardless of its (bad) rate', () => {
    const report = aggregateSkillEvidence([run('z', false), run('z', false)]);
    expect(report.findings).toEqual([]);
    expect(report.malformedRecords).toBe(0);
  });

  it('malformed records are counted and skipped (raw string, null, missing fields)', () => {
    const report = aggregateSkillEvidence([
      '"just a string"',
      null,
      { skillId: 'no-ok-field' }, // ok missing → unusable
      { ok: false }, // skillId missing → unusable
      { skillId: 'w', ok: false },
    ]);
    expect(report.malformedRecords).toBe(4);
    expect(report.findings).toEqual([]); // only 1 usable run for 'w' → below minRuns
  });

  it('all-ok records never flag; explicit opts move the bar both ways', () => {
    const good = [run('ok-skill', true), run('ok-skill', true), run('ok-skill', true), run('ok-skill', true)];
    expect(aggregateSkillEvidence(good).findings).toEqual([]);

    const half = [run('half', true), run('half', false)];
    expect(aggregateSkillEvidence(half).findings).toEqual([]); // 2 runs < default minRuns 3
    const tightened = aggregateSkillEvidence(half, { minRuns: 2, maxSuccessRate: 0.9 });
    expect(tightened.findings).toHaveLength(1);
    expect(tightened.findings[0]).toMatchObject({ id: 'skill-low-success:half', severity: 'warn' });
  });

  it('orders findings deterministically (id asc at equal severity/count) and reports counters', () => {
    const report = aggregateSkillEvidence([
      run('b-skill', false),
      run('b-skill', false),
      run('b-skill', false),
      run('a-skill', false),
      run('a-skill', false),
      run('a-skill', false),
    ]);
    expect(report.recordsScanned).toBe(6);
    expect(report.malformedRecords).toBe(0);
    expect(report.findings.map((f) => f.id)).toEqual(['skill-low-success:a-skill', 'skill-low-success:b-skill']);
  });
});
