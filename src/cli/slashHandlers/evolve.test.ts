/**
 * slashHandlers/evolve.test.ts — WS7 slice 0 residual: `/evolve` must print the
 * `honesty` + `cacheHitTokens` ledger signals added in 9a577c8 (ADR-0036).
 *
 * Red-if-reopens:
 *   - a record WITHOUT `honesty` renders "not measured" — never a clean lint;
 *   - a record WITH `honesty` renders the flagged count (0 or N), and a report
 *     whose lint family emitted nothing can never summarize as "linted";
 *   - a run with no provider usage report gets NO cache line (absence is not a
 *     0% hit rate);
 *   - `/evolve` (handleSlashCommand) actually contains those lines — the
 *     formatter is wired, not merely exported.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { LedgerEntry } from '../evolution/ledger.js';
import { ledgerStats } from '../evolution/ledger.js';
import {
  formatCacheHitStatLine,
  formatHonestyStatLine,
  formatLedgerSignalLines,
} from './evolve.js';
import { handleSlashCommand } from '../slashCommands.js';

/** Ledger fixtures handed to the mocked `readLedger` (see the mock below). */
const fixture = vi.hoisted(() => ({ entries: [] as LedgerEntry[] }));

// `readLedger` is the only I/O in the `/evolve` path; everything else (stats,
// fitness, rendering) stays REAL so the wiring test covers the true pipeline.
vi.mock('../evolution/ledger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../evolution/ledger.js')>();
  return {
    ...actual,
    evolutionMode: () => 'shadow' as const,
    readLedger: () => fixture.entries,
  };
});

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  runId: 'run-1',
  at: '2026-01-01T00:00:00.000Z',
  mode: 'shadow',
  taskClass: 'bugfix',
  verdict: 'PASS',
  ...over,
});

beforeEach(() => {
  fixture.entries = [];
});

describe('formatHonestyStatLine', () => {
  it('reports a measured, clean lint as linted (0 flagged)', () => {
    expect(formatHonestyStatLine([entry({ honesty: { linted: true, flagged: 0 } })])).toBe(
      '  honesty: linted (0 flagged)',
    );
  });

  it('reports flagged > 0 with the count and the measured denominator', () => {
    expect(formatHonestyStatLine([entry({ honesty: { linted: true, flagged: 2 } })])).toBe(
      '  honesty: lint ran, 2 flagged (1/1 run(s) measured)',
    );
  });

  it('renders absence as NOT MEASURED (unknown ≠ clean)', () => {
    expect(formatHonestyStatLine([entry()])).toBe(
      '  honesty: not measured (unknown ≠ clean, ADR-0023)',
    );
  });

  it('never summarizes an un-linted report as linted-clean', () => {
    const line = formatHonestyStatLine([entry({ honesty: { linted: false, flagged: 0 } })]);
    expect(line).not.toContain('honesty: linted (0 flagged)');
    expect(line).toContain('1 not linted');
  });

  it('sums flags over measured runs and counts the unmeasured ones out of the denominator', () => {
    const line = formatHonestyStatLine([
      entry({ runId: 'a', honesty: { linted: true, flagged: 2 } }),
      entry({ runId: 'b' }), // not measured — must not dilute the flags nor count as clean
    ]);
    expect(line).toBe('  honesty: lint ran, 2 flagged (1/2 run(s) measured)');
  });
});

describe('formatCacheHitStatLine', () => {
  const withCache = entry({ inputTokens: 100_000, cacheHitTokens: 12_345 });

  it('prints the provider-reported hit tokens and hit rate', () => {
    const entries = [withCache];
    expect(formatCacheHitStatLine(entries, ledgerStats(entries))).toBe(
      '  cache: 12.3k hit tokens · 12.3% of prompt tokens · 1 run(s) reporting',
    );
  });

  it('omits the line when no run carried a provider usage report', () => {
    const entries = [entry()];
    expect(formatCacheHitStatLine(entries, ledgerStats(entries))).toBeUndefined();
  });

  it('omits the line when the cache tokens have no prompt total or a zero one', () => {
    const noTotal = [entry({ cacheHitTokens: 500 })];
    expect(formatCacheHitStatLine(noTotal, ledgerStats(noTotal))).toBeUndefined();
    const zeroTotal = [entry({ inputTokens: 0, cacheHitTokens: 0 })];
    expect(formatCacheHitStatLine(zeroTotal, ledgerStats(zeroTotal))).toBeUndefined();
  });
});

describe('formatLedgerSignalLines', () => {
  it('emits honesty then cache for a record carrying both stats', () => {
    const entries = [
      entry({ honesty: { linted: true, flagged: 0 }, inputTokens: 1_000, cacheHitTokens: 250 }),
    ];
    expect(formatLedgerSignalLines(entries, ledgerStats(entries))).toEqual([
      '  honesty: linted (0 flagged)',
      '  cache: 250 hit tokens · 25.0% of prompt tokens · 1 run(s) reporting',
    ]);
  });

  it('keeps the honesty line (not silence) when the record carries neither stat', () => {
    const entries = [entry()];
    expect(formatLedgerSignalLines(entries, ledgerStats(entries))).toEqual([
      '  honesty: not measured (unknown ≠ clean, ADR-0023)',
    ]);
  });
});

describe('/evolve — the status message carries the signals', () => {
  it('prints honesty + cache for a record that measured both', () => {
    fixture.entries = [
      entry({ honesty: { linted: true, flagged: 3 }, inputTokens: 1_000, cacheHitTokens: 400 }),
    ];
    const res = handleSlashCommand('/evolve', []);
    expect(res.handled).toBe(true);
    expect(res.message).toContain('honesty: lint ran, 3 flagged');
    expect(res.message).toContain('cache: 400 hit tokens · 40.0% of prompt tokens');
  });

  it('prints an honest absence for a legacy record with neither field', () => {
    fixture.entries = [entry()];
    const res = handleSlashCommand('/evolve', []);
    expect(res.message).toContain('honesty: not measured (unknown ≠ clean, ADR-0023)');
    expect(res.message).not.toContain('cache:');
  });
});
