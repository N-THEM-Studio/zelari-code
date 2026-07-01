import { readSkillHistory, getSkillStats, type SkillHistoryRecord, type SkillStats } from '../skillHistory.js';

/**
 * Format a side-by-side comparison of two skills' history stats (Task H.3).
 * Pure helper extracted from app.tsx dispatch so it's testable without
 * React/Ink render.
 *
 * Returns a multi-line string with:
 *  - Two lines summarizing each skill (id, count, success, avg duration, total tokens)
 *  - A "winner" line if there's a clear winner (higher successRate wins;
 *    ties broken by lower avgDurationMs; ties beyond that → no winner)
 *
 * When a skill ID has no recorded invocations, the line shows
 * "no invocations yet" so the user can still see the comparison.
 */
export function formatSkillCompare(
  id1: string,
  id2: string,
  records: SkillHistoryRecord[],
): string {
  const stats1 = getSkillStats(records, id1);
  const stats2 = getSkillStats(records, id2);
  const lines: string[] = ['[skill-compare]'];
  lines.push(formatSkillCompareLine(id1, stats1));
  lines.push(formatSkillCompareLine(id2, stats2));
  if (stats1.count > 0 && stats2.count > 0) {
    const winner = pickCompareWinner(stats1, stats2);
    if (winner === null) {
      lines.push('Winner: tie (same success rate + same avg duration)');
    } else if (winner === 'a') {
      lines.push(`Winner: ${id1} (better success rate${stats1.successRate === stats2.successRate ? ' — tied, lower avg duration' : ''})`);
    } else {
      lines.push(`Winner: ${id2} (better success rate${stats1.successRate === stats2.successRate ? ' — tied, lower avg duration' : ''})`);
    }
  } else {
    lines.push('Winner: (insufficient data — both skills need ≥1 invocation to compare)');
  }
  return lines.join('\n');
}

/** Format a single skill's stats line for the compare output. */
export function formatSkillCompareLine(id: string, stats: SkillStats): string {
  if (stats.count === 0) {
    return `  ${id} — no invocations recorded yet`;
  }
  return `  ${id} — ${stats.count} invocations, ${(stats.successRate * 100).toFixed(1)}% success, avg ${stats.avgDurationMs.toFixed(0)}ms, ${stats.totalTokens} tokens total`;
}

/**
 * Pick the winner between two SkillStats. Returns 'a' / 'b' / null on tie.
 * Order: successRate first (higher wins), then avgDurationMs (lower wins).
 * On perfect tie (same successRate AND same avgDurationMs), returns null.
 */
export function pickCompareWinner(
  a: SkillStats,
  b: SkillStats,
): 'a' | 'b' | null {
  if (a.successRate > b.successRate) return 'a';
  if (b.successRate > a.successRate) return 'b';
  if (a.avgDurationMs < b.avgDurationMs) return 'a';
  if (b.avgDurationMs < a.avgDurationMs) return 'b';
  return null;
}

/**
 * Convenience wrapper: read history from disk + format compare. Caller
 * passes the file path so the test can inject a temp file.
 */
export async function compareSkillsFromFile(
  id1: string,
  id2: string,
  historyFile: string,
): Promise<string> {
  const records = await readSkillHistory(historyFile);
  return formatSkillCompare(id1, id2, records);
}