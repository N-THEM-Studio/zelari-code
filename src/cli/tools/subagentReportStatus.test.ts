/**
 * subagentReportStatus.test — G2 of the 2026-09-23 post-mortem remediation.
 *
 * Pure unit coverage of the report-truncation surfaces: the stable marker
 * declared inside a cut report, the note that names the deterministic reason,
 * the parent-facing guard line, and the reason → status mapping.
 */
import { describe, expect, it } from 'vitest';
import {
  REPORT_TRUNCATED_GUARD_LINE,
  REPORT_TRUNCATED_MARKER,
  formatReportTruncatedNote,
  reportStatusOf,
  type ReportTruncatedReason,
} from './subagentReportStatus.js';

describe('G2 (2026-09-23) — subagentReportStatus', () => {
  it('the note declares the marker and the deterministic reason', () => {
    const reasons: ReportTruncatedReason[] = [
      'finish-reason-length',
      'stream-cut-mid-message',
      'fatal-error-mid-message',
    ];
    for (const reason of reasons) {
      const note = formatReportTruncatedNote(reason);
      expect(note, reason).toContain(REPORT_TRUNCATED_MARKER);
      expect(note, reason).toContain(reason);
      expect(note, reason).toContain('PARTIAL report');
    }
  });

  it('the guard line is loud and names the re-investigation duty', () => {
    expect(REPORT_TRUNCATED_GUARD_LINE).toContain('report troncato');
    expect(REPORT_TRUNCATED_GUARD_LINE).toContain('non usarlo come base per nuovi spawn');
    expect(REPORT_TRUNCATED_GUARD_LINE).toContain('re-investigare');
  });

  it('maps reason → status: absent is ok, any reason is truncated', () => {
    expect(reportStatusOf(undefined)).toBe('ok');
    expect(reportStatusOf(null)).toBe('ok');
    expect(reportStatusOf('finish-reason-length')).toBe('truncated');
    expect(reportStatusOf('stream-cut-mid-message')).toBe('truncated');
    expect(reportStatusOf('fatal-error-mid-message')).toBe('truncated');
  });
});
