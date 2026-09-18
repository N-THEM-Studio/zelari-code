/**
 * K1.6 / F8 — verification claims are evaluated per-claim, never wholesale.
 *
 * Historically one `verification.evidence` event (even an unrelated command)
 * made the whole mission claim event-backed. A report of N claims where a
 * single check passes must not certify the rest. Each claim gets its own
 * VerificationResult; overall = worst; failed claim ids are identified.
 */
import { describe, expect, it } from 'vitest';
import { evaluateClaimReport } from './verificationBridge.js';

describe('K1.6 — per-claim verification, overall = worst', () => {
  it('2 claims, evidence for only 1 → overall non-pass + failed claim identified', () => {
    const report = evaluateClaimReport(
      [
        { id: 'claim-typecheck', criterionId: 'typecheck', text: 'typecheck exits 0' },
        { id: 'claim-tests', criterionId: 'tests', text: 'unit tests pass' },
      ],
      [
        {
          criterionId: 'typecheck',
          seq: 4,
          status: 'pass',
          tier: 'command-output',
          ref: 'npx tsc --noEmit',
        },
      ],
    );
    expect(report.claims).toHaveLength(2);
    expect(report.claims[0]?.result.status).toBe('pass');
    expect(report.claims[1]?.result.status).toBe('unknown');
    expect(report.overall).not.toBe('PASS');
    expect(report.failedClaimIds).toEqual(['claim-tests']);
  });

  it('every claim event-backed pass → overall PASS', () => {
    const report = evaluateClaimReport(
      [
        { id: 'a', criterionId: 'c-a' },
        { id: 'b', criterionId: 'c-b' },
      ],
      [
        { criterionId: 'c-a', seq: 1, status: 'pass', tier: 'command-output', ref: 'a' },
        { criterionId: 'c-b', seq: 2, status: 'pass', tier: 'command-output', ref: 'b' },
      ],
    );
    expect(report.overall).toBe('PASS');
    expect(report.failedClaimIds).toEqual([]);
  });

  it('one fail among claims → overall REPAIR_REQUIRED, failed id listed', () => {
    const report = evaluateClaimReport(
      [
        { id: 'ok', criterionId: 'c-ok' },
        { id: 'red', criterionId: 'c-red' },
      ],
      [
        { criterionId: 'c-ok', seq: 1, status: 'pass', tier: 'command-output', ref: 'ok' },
        { criterionId: 'c-red', seq: 2, status: 'fail', tier: 'command-output', ref: 'red' },
      ],
    );
    expect(report.overall).toBe('REPAIR_REQUIRED');
    expect(report.failedClaimIds).toContain('red');
  });
});
