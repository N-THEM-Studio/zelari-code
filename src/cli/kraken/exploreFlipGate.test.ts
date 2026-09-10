/**
 * exploreFlipGate.test.ts — t57/C4: unit coverage for the explore
 * quick-default flip gate (classification, median decision, scanner).
 *
 * Pure logic plus one temp-dir scan. No network, no repo fixture: the gate's
 * whole point is that it has to run BEFORE the flip exists, when the real
 * sidecars still all say `medium` (or say nothing at all).
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MAX_DROP_PP,
  DEFAULT_MIN_SESSIONS,
  classifySession,
  evaluateFlipGate,
  median,
  scanTentacleReports,
  type GateReportInput,
} from './exploreFlipGate.js';

let seq = 0;

/** Session fixture: only the fields the gate actually reads. */
function report(
  ratio: number,
  exploreModes?: string[],
  extra: Partial<GateReportInput> = {},
): GateReportInput {
  seq += 1;
  return {
    sessionId: `sess-${seq}`,
    ratio,
    ...(exploreModes ? { exploreModes } : {}),
    ...extra,
  };
}

/** `count` sessions of one phase, all with the same ratio. */
function phase(count: number, ratio: number, modes: string[]): GateReportInput[] {
  return Array.from({ length: count }, () => report(ratio, modes));
}

function writeCoverage(root: string, sessionId: string, payload: unknown): void {
  const dir = path.join(root, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'coverage.json'),
    typeof payload === 'string' ? payload : JSON.stringify(payload),
    'utf8',
  );
}

describe('classifySession (t57/C4)', () => {
  it('is flip only when exploreModes is exactly [quick]', () => {
    expect(classifySession(report(0.5, ['quick']))).toBe('flip');
    expect(classifySession(report(0.5, ['quick', 'quick']))).toBe('excluded');
  });

  it('is baseline when every recorded explore mode is medium/deep', () => {
    expect(classifySession(report(0.5, ['medium']))).toBe('baseline');
    expect(classifySession(report(0.5, ['deep']))).toBe('baseline');
    expect(classifySession(report(0.5, ['deep', 'medium']))).toBe('baseline');
  });

  it('excludes mixed modes: quick + anything is not a phase', () => {
    expect(classifySession(report(0.5, ['quick', 'medium']))).toBe('excluded');
    expect(classifySession(report(0.5, ['deep', 'quick']))).toBe('excluded');
  });

  it('excludes legacy sessions with no recorded mode (honest unknown, never guessed)', () => {
    expect(classifySession(report(0.5))).toBe('excluded');
    expect(classifySession(report(0.5, []))).toBe('excluded');
    expect(classifySession(null)).toBe('excluded');
    expect(classifySession(undefined)).toBe('excluded');
  });

  it('excludes a session whose explore sidecars are only PARTLY labelled', () => {
    // One quick explore + one pre-C4 sidecar: the session is not "a quick
    // session", and counting it as one would corrupt the comparison.
    expect(classifySession(report(0.5, ['quick'], { exploreModesUnknown: 1 }))).toBe('excluded');
  });

  it('excludes modes it does not know', () => {
    expect(classifySession(report(0.5, ['turbo']))).toBe('excluded');
  });
});

describe('median helper', () => {
  it('is the median, not the mean (one outlier moves neither verdict nor middle)', () => {
    expect(median([0.9, 0.9, 0.9, 0.9, 0.2])).toBe(0.9);
    expect(median([0.4, 0.8])).toBeCloseTo(0.6);
    expect(median([])).toBe(null);
  });
});

describe('evaluateFlipGate (t57/C4)', () => {
  it('is insufficient-data while either phase has fewer than minSessions', () => {
    const result = evaluateFlipGate([...phase(3, 0.9, ['medium']), ...phase(5, 0.5, ['quick'])]);
    expect(result.minSessions).toBe(DEFAULT_MIN_SESSIONS);
    expect(result.maxDropPp).toBe(DEFAULT_MAX_DROP_PP);
    expect(result.status).toBe('insufficient-data');
    expect(result.dropPp).toBe(null);
    expect(result.baseline.n).toBe(3);
    expect(result.flip.n).toBe(5);
    expect(result.reason).toContain('insufficient data');
  });

  it('is insufficient-data on an empty report list (no data is never "keep")', () => {
    const result = evaluateFlipGate([]);
    expect(result.status).toBe('insufficient-data');
    expect(result.reason).toContain('flip stays unmade');
  });

  it('keeps when the median drop is at most 10pp', () => {
    const result = evaluateFlipGate([...phase(5, 0.8, ['medium']), ...phase(5, 0.72, ['quick'])]);
    expect(result.status).toBe('keep');
    expect(result.dropPp).toBeLessThanOrEqual(DEFAULT_MAX_DROP_PP);
    expect(result.baseline.medianPp).toBe(80);
    expect(result.flip.medianPp).toBeCloseTo(72);
  });

  it('reverts when the median drop is strictly above 10pp', () => {
    const result = evaluateFlipGate([...phase(6, 0.9, ['deep']), ...phase(6, 0.7, ['quick'])]);
    expect(result.status).toBe('revert');
    expect(result.dropPp).toBeCloseTo(20);
    expect(result.reason).toContain('revert');
  });

  it('keeps at EXACTLY the threshold: a tie is not a revert', () => {
    // 0.8 − 0.7 is 10.000000000000009pp in binary floating point: the boundary
    // must follow the documented rule, not the representation.
    const result = evaluateFlipGate(
      [...phase(5, 0.8, ['medium']), ...phase(5, 0.7, ['quick'])],
      { maxDropPp: 10 },
    );
    expect(result.dropPp).toBe(10);
    expect(result.status).toBe('keep');
  });

  it('uses the median, so one outlier session cannot flip the decision', () => {
    // Mean-based: baseline mean 0.76 vs flip 0.78 → a -2pp "improvement" (keep).
    // Median-based: 0.9 vs 0.78 → a 12pp drop (revert). The gate must say revert.
    const baseline = [...phase(4, 0.9, ['medium']), report(0.2, ['medium'])];
    const result = evaluateFlipGate([...baseline, ...phase(5, 0.78, ['quick'])]);
    expect(result.baseline.medianPp).toBe(90);
    expect(result.dropPp).toBeCloseTo(12);
    expect(result.status).toBe('revert');
  });

  it('counts excluded sessions outside both phases', () => {
    const reports = [
      ...phase(4, 0.9, ['medium']), // one short of the minimum
      ...phase(5, 0.8, ['quick']),
      report(0.5, ['quick', 'medium']), // mixed
      report(0.5), // legacy: no mode at all
      report(Number.NaN, ['medium']), // unusable ratio
    ];
    const result = evaluateFlipGate(reports);
    expect(result.baseline.n).toBe(4);
    expect(result.flip.n).toBe(5);
    expect(result.excludedCount).toBe(3);
    expect(result.status).toBe('insufficient-data');
  });

  it('classifies legacy and mixed sessions out even when both phases are full', () => {
    const reports = [
      ...phase(5, 0.85, ['deep']),
      ...phase(5, 0.83, ['quick']),
      report(0.85), // legacy baseline: unknown mode → excluded, not guessed
      report(0.85, ['quick', 'deep']), // mixed → excluded
    ];
    const result = evaluateFlipGate(reports);
    expect(result.status).toBe('keep');
    expect(result.excludedCount).toBe(2);
  });
});

describe('scanTentacleReports (t57/C4)', () => {
  it('reads every session coverage.json and skips the corrupt ones, not the run', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'zelari-gate-'));
    try {
      writeCoverage(root, 'sess-ok', {
        sessionId: 'sess-ok',
        ratio: 0.75,
        exploreModes: ['quick'],
        computedAt: '2026-01-01T00:00:00.000Z',
      });
      writeCoverage(root, 'sess-broken-json', '{ this is not json');
      writeCoverage(root, 'sess-not-a-report', { mentioned: ['src/a.ts'] });
      mkdirSync(path.join(root, 'sess-no-coverage'), { recursive: true });

      const scan = await scanTentacleReports(root);
      expect(scan.dirMissing).toBe(false);
      expect(scan.reports).toHaveLength(1);
      expect(scan.reports[0]!.sessionId).toBe('sess-ok');
      expect(scan.reports[0]!.exploreModes).toEqual(['quick']);
      expect(scan.skipped).toBe(3); // broken JSON + non-report + missing file
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('takes the session id from the directory when the report omits it (legacy)', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'zelari-gate-legacy-'));
    try {
      writeCoverage(root, 'sess-legacy', { ratio: 0.6 });
      const scan = await scanTentacleReports(root);
      expect(scan.reports.map((r) => r.sessionId)).toEqual(['sess-legacy']);
      expect(evaluateFlipGate(scan.reports).status).toBe('insufficient-data');
      expect(evaluateFlipGate(scan.reports).excludedCount).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a missing root is an honest empty scan, never a throw', async () => {
    const missing = path.join(tmpdir(), `zelari-gate-missing-${Date.now()}`);
    const scan = await scanTentacleReports(missing);
    expect(scan).toEqual({ root: path.resolve(missing), reports: [], skipped: 0, dirMissing: true });
    expect(evaluateFlipGate(scan.reports).status).toBe('insufficient-data');
  });

  it('decides end-to-end from scanned reports (5 medium vs 5 quick → keep)', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'zelari-gate-e2e-'));
    try {
      for (let i = 0; i < 5; i += 1) {
        writeCoverage(root, `base-${i}`, { ratio: 0.8, exploreModes: ['medium'] });
        writeCoverage(root, `flip-${i}`, { ratio: 0.75, exploreModes: ['quick'] });
      }
      const scan = await scanTentacleReports(root);
      const result = evaluateFlipGate(scan.reports);
      expect(result.baseline.n).toBe(5);
      expect(result.flip.n).toBe(5);
      expect(result.status).toBe('keep');
      expect(result.dropPp).toBeCloseTo(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
