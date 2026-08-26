/**
 * tools/eval/regressionGate.rate.test.ts — §P1.2 strict verification gate.
 *
 * Covers the t13 additions on top of the retention gate:
 *  - HarnessEvalResult.verifiedSolveRate: computed over RAW candidate
 *    records, null iff zero candidate records
 *  - policy.minVerificationGatePassRate rejects below-threshold candidates
 *    with a human-readable reason and FAILS CLOSED on an empty set
 *  - formatGateReport renders the rate (+ required threshold when opted in)
 *  - the two new strict-gate anchors parse against AnchorManifestSchema
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { evaluateRegressionGate } from './regressionGate.ts';
import { RETENTION_PRESETS } from './retentionPolicy.ts';
import { formatGateReport } from './report.ts';
import { zeroCost } from './cost.ts';
import type { AnchorRunRecord } from './types.ts';
import { AnchorManifestSchema } from './types.ts';

/** Same record-builder shape as evalSuite.test.ts (`verified ⇔ result==='pass'`). */
function rec(anchorId: string, result: AnchorRunRecord['result'], costUsd = 0.1): AnchorRunRecord {
  return {
    runId: 'r',
    anchorId,
    anchorVersion: 1,
    harnessManifestHash: 'h',
    resourcePolicyHash: 'p',
    result,
    verified: result === 'pass',
    cost: { ...zeroCost(), modelCostUsd: costUsd, toolCalls: 5, wallMs: 60_000 },
    exitCode: result === 'pass' ? 0 : 1,
    recordedAt: '2026-01-01T00:00:00Z',
  };
}

const base = [rec('a1', 'pass'), rec('a2', 'pass'), rec('a3', 'pass')];
const VERIFICATION_DIR = path.resolve(import.meta.dirname, '../../eval/anchors/verification');

describe('verifiedSolveRate (§P1.2)', () => {
  it('is computed over raw candidate records; presets stay opt-in (undefined)', () => {
    const cmp = evaluateRegressionGate({
      manifestHash: 'cand',
      baseline: base,
      candidate: [rec('a1', 'pass'), rec('a2', 'fail'), rec('a3', 'blocked'), rec('x9', 'fail')],
      currentSuite: { passed: 10, total: 10 },
      policy: RETENTION_PRESETS.stable,
    });
    expect(cmp.result.candidateRecords).toBe(4);
    expect(cmp.result.verifiedSolveRate).toBeCloseTo(0.25, 10);
    // Opt-in policy: no preset silently gains the strict gate.
    for (const preset of Object.values(RETENTION_PRESETS)) {
      expect(preset.minVerificationGatePassRate).toBeUndefined();
    }
  });

  it('is null iff there are zero candidate records', () => {
    const cmp = evaluateRegressionGate({
      manifestHash: 'cand',
      baseline: [],
      candidate: [],
      currentSuite: { passed: 0, total: 0 },
      policy: RETENTION_PRESETS.stable,
    });
    expect(cmp.result.candidateRecords).toBe(0);
    expect(cmp.result.verifiedSolveRate).toBeNull();
  });
});

describe('minVerificationGatePassRate commit rule (§P1.2)', () => {
  it('REJECTs below-threshold candidates with a readable reason (10/14 < 0.80)', () => {
    const candidate = [
      ...Array.from({ length: 10 }, (_, i) => rec(`ok${i}`, 'pass')),
      ...Array.from({ length: 4 }, (_, i) => rec(`bad${i}`, 'fail')),
    ];
    const cmp = evaluateRegressionGate({
      manifestHash: 'cand',
      baseline: [rec('a1', 'pass')],
      candidate,
      currentSuite: { passed: 10, total: 14 },
      policy: { ...RETENTION_PRESETS.experimental, minVerificationGatePassRate: 0.8 },
    });
    expect(cmp.decision).toBe('REJECT');
    expect(cmp.reasons.join('\n')).toMatch(/verified solve rate 0\.71 < required 0\.80 \(10\/14\)/);
  });

  it('COMMITs at and above the threshold', () => {
    const make = (passes: number, fails: number) => ({
      baseline: [rec('a1', 'pass')],
      candidate: [
        ...Array.from({ length: passes }, (_, i) => rec(`ok${i}`, 'pass')),
        ...Array.from({ length: fails }, (_, i) => rec(`bad${i}`, 'fail')),
      ],
      currentSuite: { passed: passes, total: passes + fails },
      policy: { ...RETENTION_PRESETS.experimental, minVerificationGatePassRate: 0.8 },
    });
    const above = evaluateRegressionGate({ manifestHash: 'cand', ...make(13, 1) }); // 0.929
    expect(above.decision).toBe('COMMIT');
    const exact = evaluateRegressionGate({ manifestHash: 'cand', ...make(8, 2) }); // 0.80 exactly
    expect(exact.decision).toBe('COMMIT');
  });

  it('FAILS CLOSED: null rate (no candidate records) rejects even on an empty union', () => {
    const cmp = evaluateRegressionGate({
      manifestHash: 'cand',
      baseline: [],
      candidate: [],
      currentSuite: { passed: 0, total: 0 },
      policy: { ...RETENTION_PRESETS.research, minVerificationGatePassRate: 0.5 },
    });
    expect(cmp.decision).toBe('REJECT');
    expect(cmp.reasons).toContain('verified solve rate n/a (no candidate records)');
  });
});

describe('gate report verification column (§P1.2 / §8.6)', () => {
  it('renders the rate next to cost and appends the threshold when configured', () => {
    const policy = { ...RETENTION_PRESETS.experimental, minVerificationGatePassRate: 0.8 };
    const below = evaluateRegressionGate({
      manifestHash: 'abcdef1234',
      baseline: [rec('a1', 'pass')],
      candidate: [rec('a1', 'fail'), rec('a2', 'pass')],
      currentSuite: { passed: 18, total: 20 },
      policy,
    });
    const text = formatGateReport(below, { anchorsPassed: 1, anchorsTotal: 2, costPerVerifiedSolve: 0.18 });
    expect(text).toContain('Verified solve rate: 1/2 (50%)');
    expect(text).toContain('(required ≥ 80%)');
    expect(text.indexOf('Cost / verified solve')).toBeLessThan(text.indexOf('Verified solve rate'));

    // Without the opt-in the plain rate still renders, threshold absent.
    const plain = formatGateReport(
      evaluateRegressionGate({
        manifestHash: 'abcdef1234',
        baseline: [rec('a1', 'pass')],
        candidate: [rec('a1', 'pass')],
        currentSuite: { passed: 20, total: 20 },
        policy: RETENTION_PRESETS.stable,
      }),
      { anchorsPassed: 1, anchorsTotal: 1, costPerVerifiedSolve: null },
    );
    expect(plain).toContain('Verified solve rate: 1/1 (100%)');
    expect(plain).not.toContain('required ≥');
  });
});

describe('strict-gate anchors (t13) schema-validity', () => {
  for (const file of ['strict-gate-completion-proof.anchor.json', 'strict-gate-false-done.anchor.json']) {
    it(`parses ${file} against AnchorManifestSchema`, () => {
      const raw = JSON.parse(readFileSync(path.join(VERIFICATION_DIR, file), 'utf8')) as unknown;
      const anchor = AnchorManifestSchema.parse(raw);
      expect(anchor.tier).toBe(1);
      expect(anchor.profile).toBe('kraken/v1');
      expect(anchor.phase).toBe('build');
      expect(anchor.tags).toContain('strict-gate');
      expect(anchor.success.length).toBeGreaterThanOrEqual(1);
    });
  }
});
