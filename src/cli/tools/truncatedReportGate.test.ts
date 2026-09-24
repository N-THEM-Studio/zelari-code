/**
 * truncatedReportGate.test — W6.2 pure state machine.
 *
 * One-shot semantics, general-only consumption, session isolation,
 * repeated-truncation re-arm, env kill-switch, stable banner marker.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  TRUNCATED_REPORT_BANNER,
  TRUNCATED_REPORT_BANNER_MARKER,
  TRUNCATED_REPORT_GATE_ENV,
  consumeTruncatedReportBanner,
  recordTruncatedReport,
  resetTruncatedReportGateForTests,
  truncatedReportGateEnabled,
} from './truncatedReportGate.js';

afterEach(() => {
  resetTruncatedReportGateForTests();
  delete process.env[TRUNCATED_REPORT_GATE_ENV];
});

describe('W6.2 (2026-09-23) — truncatedReportGate (pure state machine)', () => {
  it('record → the next general consume returns the banner exactly once (one-shot)', () => {
    recordTruncatedReport('s1');
    expect(consumeTruncatedReportBanner('s1', 'general')).toBe(TRUNCATED_REPORT_BANNER);
    expect(consumeTruncatedReportBanner('s1', 'general')).toBeNull();
  });

  it('explore/verify never consume the flag — only general does', () => {
    recordTruncatedReport('s2');
    expect(consumeTruncatedReportBanner('s2', 'explore')).toBeNull();
    expect(consumeTruncatedReportBanner('s2', 'verify')).toBeNull();
    // Still armed for the general: re-investigating must not spend the warning.
    expect(consumeTruncatedReportBanner('s2', 'general')).toBe(TRUNCATED_REPORT_BANNER);
  });

  it('sessions are isolated; a repeated truncation re-arms the flag', () => {
    recordTruncatedReport('s3');
    expect(consumeTruncatedReportBanner('other', 'general')).toBeNull();
    recordTruncatedReport('s3');
    expect(consumeTruncatedReportBanner('s3', 'general')).toBe(TRUNCATED_REPORT_BANNER);
  });

  it('kill-switch env =0 disables both record and consume', () => {
    process.env[TRUNCATED_REPORT_GATE_ENV] = '0';
    expect(truncatedReportGateEnabled()).toBe(false);
    recordTruncatedReport('s4');
    expect(consumeTruncatedReportBanner('s4', 'general')).toBeNull();
  });

  it('the banner carries the stable marker', () => {
    expect(TRUNCATED_REPORT_BANNER).toContain(TRUNCATED_REPORT_BANNER_MARKER);
  });
});
