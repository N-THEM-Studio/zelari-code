/**
 * verifyReport.test — Fase 7 (ADR-0020): structured verification.
 *   - parse `<verify-report>` blocks (pass/fail/unknown per required check)
 *   - unmatched / invalid / missing status → unknown (never pass)
 *   - wording-tolerant matching (normalized equality, then containment)
 *   - later duplicate blocks win
 *   - failed tentacle → allUnknownCheckResults
 */
import { describe, expect, it } from 'vitest';
import {
  allUnknownCheckResults,
  extractVerifyReportBlocks,
  parseVerifyReport,
} from './verifyReport.js';

const CHECKS = [
  'unit test for session refresh passes',
  'no Set-Cookie regression on logout',
] as const;

function block(check: string, status: string, note?: string): string {
  return [
    '<verify-report>',
    `check: ${check}`,
    `status: ${status}`,
    ...(note ? [`note: ${note}`] : []),
    '</verify-report>',
  ].join('\n');
}

const REPORTED = [
  'Ran the targeted suite.',
  block(CHECKS[0], 'pass', 'vitest src/auth 41/41 green'),
  block(CHECKS[1], 'fail', 'logout still emits double Set-Cookie'),
].join('\n');

describe('extractVerifyReportBlocks', () => {
  it('extracts blocks with check/status/note', () => {
    const blocks = extractVerifyReportBlocks(REPORTED);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ check: CHECKS[0], status: 'pass', note: 'vitest src/auth 41/41 green' });
    expect(blocks[1]).toMatchObject({ check: CHECKS[1], status: 'fail' });
  });

  it('skips blocks without a check line and tolerates prose between blocks', () => {
    const raw = [
      'prose',
      '<verify-report>',
      'status: pass',
      '</verify-report>',
      'more prose',
      block('some check', 'unknown'),
    ].join('\n');
    const blocks = extractVerifyReportBlocks(raw);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].check).toBe('some check');
  });

  it('stops at an unterminated block (no close tag)', () => {
    const raw = '<verify-report>\ncheck: x\nstatus: pass';
    expect(extractVerifyReportBlocks(raw)).toEqual([]);
  });
});

describe('parseVerifyReport', () => {
  it('maps each required check to its reported status', () => {
    const results = parseVerifyReport(REPORTED, CHECKS);
    expect(results[0]).toMatchObject({ check: CHECKS[0], status: 'pass' });
    expect(results[1]).toMatchObject({ check: CHECKS[1], status: 'fail' });
  });

  it('unmatched check → unknown, never pass', () => {
    const raw = block(CHECKS[0], 'pass');
    const results = parseVerifyReport(raw, CHECKS);
    expect(results[0].status).toBe('pass');
    expect(results[1].status).toBe('unknown');
    expect(results[1].note).toContain('no verify-report block');
  });

  it('invalid status word → unknown', () => {
    const raw = block(CHECKS[0], 'mostly-fine');
    expect(parseVerifyReport(raw, [CHECKS[0]])[0].status).toBe('unknown');
  });

  it('missing status line → unknown', () => {
    const raw = ['<verify-report>', `check: ${CHECKS[0]}`, '</verify-report>'].join('\n');
    expect(parseVerifyReport(raw, [CHECKS[0]])[0].status).toBe('unknown');
  });

  it('matches a lightly reworded criterion (containment, case-insensitive)', () => {
    const raw = block('Unit test for Session REFRESH passes (targeted)', 'pass');
    expect(parseVerifyReport(raw, [CHECKS[0]])[0].status).toBe('pass');
  });

  it('later duplicate block for the same check wins (self-correction)', () => {
    const raw = [block(CHECKS[0], 'fail'), block(CHECKS[0], 'pass', 're-ran: green')].join('\n');
    const results = parseVerifyReport(raw, [CHECKS[0]]);
    expect(results[0].status).toBe('pass');
    expect(results[0].note).toBe('re-ran: green');
  });

  it('no blocks at all → every check unknown', () => {
    const results = parseVerifyReport('plain conclusion, no structure', CHECKS);
    expect(results.map((r) => r.status)).toEqual(['unknown', 'unknown']);
  });

  it('empty required list → empty results', () => {
    expect(parseVerifyReport(REPORTED, [])).toEqual([]);
  });

  it('unknown status from a legit `unknown` report is preserved verbatim', () => {
    const raw = block(CHECKS[0], 'unknown', 'grep timed out');
    const results = parseVerifyReport(raw, [CHECKS[0]]);
    expect(results[0]).toMatchObject({ status: 'unknown', note: 'grep timed out' });
  });
});

describe('allUnknownCheckResults', () => {
  it('marks every check unknown with the failure reason', () => {
    const results = allUnknownCheckResults(CHECKS, 'verify tentacle failed: timeout');
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.status).toBe('unknown');
      expect(r.note).toBe('verify tentacle failed: timeout');
    }
  });

  it('empty list → empty results', () => {
    expect(allUnknownCheckResults([], 'x')).toEqual([]);
  });
});
