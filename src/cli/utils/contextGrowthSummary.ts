/**
 * contextGrowthSummary — aggregate Fase M context-growth metrics for doctor.
 *
 * Reads the tail of `metrics.jsonl` (records with `kind: 'run'` carrying the
 * Fase M per-run counters) and folds them into a compact summary that makes
 * the "context-growth avoidance" work measurable across sessions:
 *
 *   - tool round-trips per run          (observe_batch target: −50%)
 *   - intermediate tool bytes per run   (evidence mode target: −70%)
 *   - history bytes at request          (SessionSurface target: −40%)
 *   - cache-hit tokens                  (must not regress)
 *
 * Pure functions — no fs imports — so the aggregation is unit-testable;
 * doctor wires the metrics file in.
 */

/** Shape of a `kind: 'run'` metrics record that carries Fase M counters. */
export interface ContextGrowthRunRecord {
  ts?: number;
  toolRoundTrips?: number;
  intermediateToolBytes?: number;
  requests?: number;
  historyBytesAtRequest?: number;
  historyBytesPeak?: number;
  cacheHitTokens?: number;
}

export interface ContextGrowthSummary {
  /** Number of instrumented runs in the window. */
  runs: number;
  totalToolRoundTrips: number;
  avgToolRoundTrips: number;
  totalIntermediateToolBytes: number;
  avgIntermediateToolBytes: number;
  avgHistoryBytesAtRequest: number;
  maxHistoryBytesAtRequest: number;
  totalCacheHitTokens: number;
}

/**
 * Fold the last `window` instrumented run records into a summary.
 * Records without Fase M counters (older sessions, council runs) are skipped.
 * Returns null when nothing instrumented is available yet.
 */
export function summarizeContextGrowth(
  records: ContextGrowthRunRecord[],
  window = 20,
): ContextGrowthSummary | null {
  const instrumented = records.filter(r => typeof r.toolRoundTrips === 'number');
  if (instrumented.length === 0) return null;
  const tail = instrumented.slice(-window);
  const n = tail.length;
  const sum = (f: (r: ContextGrowthRunRecord) => number): number =>
    tail.reduce((acc, r) => acc + f(r), 0);
  return {
    runs: n,
    totalToolRoundTrips: sum(r => r.toolRoundTrips ?? 0),
    avgToolRoundTrips: sum(r => r.toolRoundTrips ?? 0) / n,
    totalIntermediateToolBytes: sum(r => r.intermediateToolBytes ?? 0),
    avgIntermediateToolBytes: sum(r => r.intermediateToolBytes ?? 0) / n,
    avgHistoryBytesAtRequest: sum(r => r.historyBytesAtRequest ?? 0) / n,
    maxHistoryBytesAtRequest: tail.reduce(
      (m, r) => Math.max(m, r.historyBytesAtRequest ?? r.historyBytesPeak ?? 0),
      0,
    ),
    totalCacheHitTokens: sum(r => r.cacheHitTokens ?? 0),
  };
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

/** Human-readable doctor lines (one per metric family). */
export function formatContextGrowthSummary(s: ContextGrowthSummary): string[] {
  return [
    `runs ${s.runs} · tool round-trips avg ${s.avgToolRoundTrips.toFixed(1)} (total ${s.totalToolRoundTrips})`,
    `intermediate tool bytes avg ${fmtBytes(s.avgIntermediateToolBytes)} (total ${fmtBytes(s.totalIntermediateToolBytes)})`,
    `history@request avg ${fmtBytes(s.avgHistoryBytesAtRequest)} · peak ${fmtBytes(s.maxHistoryBytesAtRequest)}`,
    `cache-hit tokens ${s.totalCacheHitTokens.toLocaleString('en-US')}`,
  ];
}
