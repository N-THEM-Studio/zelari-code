/**
 * Fase M tests — contextGrowthSummary aggregation (doctor-facing).
 */
import { describe, expect, it } from 'vitest';
import {
  formatContextGrowthSummary,
  summarizeContextGrowth,
  type ContextGrowthRunRecord,
} from './contextGrowthSummary.js';

const run = (over: Partial<ContextGrowthRunRecord>): ContextGrowthRunRecord => ({
  toolRoundTrips: 5,
  intermediateToolBytes: 40_000,
  requests: 6,
  historyBytesAtRequest: 120_000,
  historyBytesPeak: 120_000,
  cacheHitTokens: 9_000,
  ...over,
});

describe('summarizeContextGrowth', () => {
  it('returns null when no instrumented runs exist', () => {
    expect(summarizeContextGrowth([])).toBeNull();
    const legacy: ContextGrowthRunRecord = { ts: 1 }; // pre-Fase-M run: no counters
    expect(summarizeContextGrowth([legacy, { ts: 2, requests: 3 }])).toBeNull();
  });

  it('skips pre-Fase-M records and aggregates the rest', () => {
    const legacy: ContextGrowthRunRecord = { ts: 1 };
    const summary = summarizeContextGrowth([
      legacy, // no counters: skipped by the filter
      run({ toolRoundTrips: 4, intermediateToolBytes: 10_000, cacheHitTokens: 1_000 }),
      run({ toolRoundTrips: 6, intermediateToolBytes: 30_000, cacheHitTokens: 3_000 }),
    ]);
    expect(summary).not.toBeNull();
    expect(summary!.runs).toBe(2);
    expect(summary!.totalToolRoundTrips).toBe(10);
    expect(summary!.avgToolRoundTrips).toBe(5);
    expect(summary!.avgIntermediateToolBytes).toBe(20_000);
    expect(summary!.totalCacheHitTokens).toBe(4_000);
  });

  it('windows to the last N instrumented runs', () => {
    const records = [
      run({ toolRoundTrips: 1 }),
      run({ toolRoundTrips: 2 }),
      run({ toolRoundTrips: 3 }),
    ];
    const summary = summarizeContextGrowth(records, 2);
    expect(summary!.runs).toBe(2);
    expect(summary!.totalToolRoundTrips).toBe(5); // last two, oldest dropped
  });

  it('maxHistoryBytesAtRequest falls back to peak when request size missing', () => {
    const summary = summarizeContextGrowth([
      run({ historyBytesAtRequest: undefined, historyBytesPeak: 250_000 }),
    ]);
    expect(summary!.maxHistoryBytesAtRequest).toBe(250_000);
    expect(summary!.avgHistoryBytesAtRequest).toBe(0);
  });
});

describe('formatContextGrowthSummary', () => {
  it('renders one line per metric family with human byte sizes', () => {
    const lines = formatContextGrowthSummary({
      runs: 3,
      totalToolRoundTrips: 12,
      avgToolRoundTrips: 4,
      totalIntermediateToolBytes: 150_000,
      avgIntermediateToolBytes: 50_000,
      avgHistoryBytesAtRequest: 2 * 1024 * 1024,
      maxHistoryBytesAtRequest: 3 * 1024 * 1024,
      totalCacheHitTokens: 123_456,
    });
    expect(lines.length).toBe(4);
    expect(lines[0]!).toContain('runs 3');
    expect(lines[0]!).toContain('avg 4.0');
    expect(lines[1]!).toContain('48.8 KB');
    expect(lines[2]!).toContain('2.0 MB');
    expect(lines[2]!).toContain('peak 3.0 MB');
    expect(lines[3]!).toContain('123,456');
  });
});
