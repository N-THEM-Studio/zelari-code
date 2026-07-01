/**
 * Format a millisecond duration as a short human-readable string.
 * Negative durations get an "ago" suffix (Task F.3, v3-F).
 *
 * Examples:
 *   45_000    → "45s"
 *   3_600_000 → "1h 0m"
 *   86_400_000 → "1d 0h"
 *   -120_000  → "2m ago"
 *
 * Extracted from app.tsx (Task v0.4.2 audit split) so other modules
 * (slashHandlers, test files) can import without pulling in the full App.
 */
export function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  const sign = ms < 0 ? ' ago' : '';
  if (abs < 1000) return `${abs}ms${sign}`;
  const s = Math.floor(abs / 1000);
  if (s < 60) return `${s}s${sign}`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs === 0 ? `${m}m${sign}` : `${m}m ${rs}s${sign}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm === 0 ? `${h}h${sign}` : `${h}h ${rm}m${sign}`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh === 0 ? `${d}d${sign}` : `${d}d ${rh}h${sign}`;
}