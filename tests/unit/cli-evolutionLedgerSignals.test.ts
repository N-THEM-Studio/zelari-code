/**
 * cli-evolutionLedgerSignals.test.ts — WS7 slice 0: `honesty` + `cacheHitTokens`
 * in the evolution ledger payload (ADR-0036).
 *
 * Contract pinned here:
 *   - `honestyFromVerificationResults` is TOTAL: no report → `undefined`
 *     (unknown, never "clean"); a report whose honesty family is clean →
 *     `{ linted: true, flagged: 0 }`;
 *   - only FAILED `synthesis.*` checks count (a passing check is not a
 *     violation, a non-honesty failure is not a honesty failure);
 *   - `classFitness` / `ledgerStats` expose `avgHonestyFlags` and
 *     `cacheHitRate` ONLY when entries carry the data — absence is not a 0;
 *   - the new keys are OPTIONAL, so pre-existing ledger lines stay replayable.
 */
import { describe, expect, it } from 'vitest';
import {
  honestyFromVerificationResults,
  ledgerStats,
  type LedgerEntry,
} from '../../src/cli/evolution/ledger.js';

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  runId: 'run-1',
  at: '2026-01-01T00:00:00.000Z',
  mode: 'shadow',
  taskClass: 'bugfix',
  verdict: 'PASS',
  ...over,
});

describe('honestyFromVerificationResults', () => {
  it('returns undefined when there is no report at all (unknown ≠ clean)', () => {
    expect(honestyFromVerificationResults(undefined)).toBeUndefined();
    expect(honestyFromVerificationResults(null)).toBeUndefined();
  });

  it('flags a failed synthesis.honesty check', () => {
    expect(
      honestyFromVerificationResults([
        { id: 'synthesis.honesty', ok: false },
        { id: 'build.pack', ok: true },
      ]),
    ).toEqual({ linted: true, flagged: 1 });
  });

  it('reports a clean lint as linted with zero flags (not as absence)', () => {
    expect(honestyFromVerificationResults([{ id: 'build.pack', ok: true }])).toEqual({
      linted: true,
      flagged: 0,
    });
  });

  it('does not count non-honesty failures', () => {
    expect(
      honestyFromVerificationResults([
        { id: 'css.dead-hook', ok: false },
        { id: 'synthesis.honesty', ok: true },
      ]),
    ).toEqual({ linted: true, flagged: 0 });
  });

  it('counts the whole synthesis.* family (tier-inflation, cite-invalid)', () => {
    expect(
      honestyFromVerificationResults([
        { id: 'synthesis.honesty', ok: false },
        { id: 'synthesis.tier-inflation', ok: false },
        { id: 'synthesis.cite-invalid', ok: false },
      ])?.flagged,
    ).toBe(3);
  });
});

describe('ledgerStats — honesty aggregate', () => {
  it('averages honesty flags over the entries that carried them', () => {
    const stats = ledgerStats([
      entry({ runId: 'a', honesty: { linted: true, flagged: 0 } }),
      entry({ runId: 'b', honesty: { linted: true, flagged: 2 } }),
      entry({ runId: 'c' }), // no honesty — excluded from the mean, not a 0
    ]);
    expect(stats.avgHonestyFlags).toBe(1);
    expect(stats.byClassFitness['bugfix']?.avgHonestyFlags).toBe(1);
  });

  it('omits the key entirely when no entry was measured', () => {
    const stats = ledgerStats([entry({ runId: 'a' })]);
    expect(stats.avgHonestyFlags).toBeUndefined();
    expect('avgHonestyFlags' in stats).toBe(false);
    expect(stats.byClassFitness['bugfix']?.avgHonestyFlags).toBeUndefined();
  });
});

describe('ledgerStats — cache-hit aggregate', () => {
  it('is token-weighted across entries that carry both numbers', () => {
    const stats = ledgerStats([
      entry({ runId: 'a', inputTokens: 1000, cacheHitTokens: 900 }),
      entry({ runId: 'b', inputTokens: 1000, cacheHitTokens: 100 }),
    ]);
    expect(stats.cacheHitRate).toBeCloseTo(0.5, 10);
  });

  it('ignores entries with no provider cache report (absence ≠ 0%)', () => {
    const stats = ledgerStats([
      entry({ runId: 'a', inputTokens: 1000, cacheHitTokens: 900 }),
      entry({ runId: 'b', inputTokens: 1000 }), // no cache report → excluded
      entry({ runId: 'c', cacheHitTokens: 500 }), // no prompt total → excluded
    ]);
    expect(stats.cacheHitRate).toBeCloseTo(0.9, 10);
  });

  it('omits the key when nothing was cache-reported, and never divides by 0', () => {
    const stats = ledgerStats([
      entry({ runId: 'a', inputTokens: 0, cacheHitTokens: 0 }),
      entry({ runId: 'b', inputTokens: 500 }),
    ]);
    expect(stats.cacheHitRate).toBeUndefined();
    expect('cacheHitRate' in stats).toBe(false);
  });
});

describe('ledger replay tolerance', () => {
  it('a pre-WS7 line (no honesty / cacheHitTokens) parses and aggregates', () => {
    const legacy = JSON.parse(
      JSON.stringify({ runId: 'old', at: '2026-01-01T00:00:00.000Z', mode: 'shadow', taskClass: 'docs', verdict: 'FAIL' }),
    ) as LedgerEntry;
    const stats = ledgerStats([legacy]);
    expect(stats.runs).toBe(1);
    expect(stats.avgHonestyFlags).toBeUndefined();
    expect(stats.cacheHitRate).toBeUndefined();
  });
});
