/**
 * slashHandlers/evolve — render helpers for the `/evolve` status screen
 * (WS7 slice 0 residual, ADR-0036).
 *
 * `handleSlashCommand` owns the I/O (`readLedger`); this module only turns the
 * records it already read into display lines, so every "we did not measure
 * this" case is unit-testable without a filesystem.
 *
 * Honesty rule (ADR-0023 / P1): a missing signal is rendered as ABSENCE, never
 * as a clean pass — unknown ≠ pass. `honesty` is absent from ledger records
 * written where no verification report was in scope, and `cacheHitTokens` is
 * absent when no provider usage report backed it; both are surfaced
 * distinguishably from a measured zero.
 */
import type { LedgerEntry, LedgerHonesty, LedgerStats } from '../evolution/ledger.js';
import { formatTokens } from '../modelPricing.js';

/** Records that actually carry the (optional) honesty signal. */
function measuredRows(
  entries: readonly LedgerEntry[],
): (LedgerEntry & { honesty: LedgerHonesty })[] {
  return entries.filter(
    (e): e is LedgerEntry & { honesty: LedgerHonesty } => e.honesty !== undefined,
  );
}

/**
 * Honesty line — ALWAYS emitted for a non-empty ledger: with nothing measured
 * it says so, instead of implying a clean lint that never ran.
 */
export function formatHonestyStatLine(entries: readonly LedgerEntry[]): string {
  const rows = measuredRows(entries);
  if (rows.length === 0) return '  honesty: not measured (unknown ≠ clean, ADR-0023)';
  const flagged = rows.reduce((acc, e) => acc + e.honesty.flagged, 0);
  const linted = rows.filter((e) => e.honesty.linted).length;
  if (flagged === 0 && linted === rows.length) return '  honesty: linted (0 flagged)';
  const notLinted = rows.length - linted;
  return `  honesty: lint ran, ${flagged} flagged (${rows.length}/${entries.length} run(s) measured${
    notLinted > 0 ? `, ${notLinted} not linted` : ''
  })`;
}

/**
 * Cache line — `undefined` when no run carried a provider usage report
 * (absence is NOT a 0% hit rate, so it is omitted exactly like the other
 * optional stats in `/evolve`). The row filter mirrors `cacheHitRate` in
 * evolution/ledger.ts, which supplies the rate: both agree by construction.
 */
export function formatCacheHitStatLine(
  entries: readonly LedgerEntry[],
  stats: LedgerStats,
): string | undefined {
  const rows = entries.filter(
    (e): e is LedgerEntry & { cacheHitTokens: number; inputTokens: number } =>
      typeof e.cacheHitTokens === 'number' &&
      typeof e.inputTokens === 'number' &&
      e.inputTokens > 0,
  );
  if (rows.length === 0 || stats.cacheHitRate === undefined) return undefined;
  const hit = rows.reduce((acc, e) => acc + e.cacheHitTokens, 0);
  return `  cache: ${formatTokens(hit)} hit tokens · ${(stats.cacheHitRate * 100).toFixed(1)}% of prompt tokens · ${rows.length} run(s) reporting`;
}

/** Lines spliced into the `/evolve` status message (honesty first, cache next). */
export function formatLedgerSignalLines(
  entries: readonly LedgerEntry[],
  stats: LedgerStats,
): string[] {
  const cache = formatCacheHitStatLine(entries, stats);
  return [formatHonestyStatLine(entries), ...(cache !== undefined ? [cache] : [])];
}
