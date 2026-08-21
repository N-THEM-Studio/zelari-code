/**
 * NDJSON / Desktop events for the Gauntlet host loop.
 */
export type GauntletPhase =
  | 'decomposing'
  | 'building'
  | 'critiquing'
  | 'repairing'
  | 'settled'
  | 'blocked';

export interface GauntletProgressView {
  phase: GauntletPhase;
  pieceId: string;
  pieceLabel: string;
  pieceIndex: number;
  pieceCount: number;
  round: number;
  maxRounds: number;
  verdict?: 'PASS' | 'GAP' | 'BLOCKED';
  gap?: string;
  winner?: 'A' | 'B' | 'TIE';
  elapsedMs: number;
}

export function gauntletProgressEvent(
  sessionId: string,
  progress: GauntletProgressView,
): { type: 'gauntlet_progress'; sessionId: string; ts: number; progress: GauntletProgressView } {
  return {
    type: 'gauntlet_progress',
    sessionId,
    ts: Date.now(),
    progress,
  };
}

export function formatGauntletSummary(
  results: ReadonlyArray<{
    id: string;
    label: string;
    verdict: string;
    rounds: number;
    gap?: string;
    winner?: 'A' | 'B' | 'TIE';
  }>,
  opts?: { timedOut?: boolean; cancelled?: boolean },
): string {
  if (results.length === 0) {
    if (opts?.timedOut) return 'Gauntlet stopped: wall clock. No pieces finished.';
    if (opts?.cancelled) return 'Gauntlet cancelled. No pieces finished.';
    return 'Gauntlet: no pieces ran.';
  }
  const head = opts?.timedOut
    ? 'Gauntlet stopped: wall clock.'
    : opts?.cancelled
      ? 'Gauntlet cancelled.'
      : 'Gauntlet finished.';
  const lines = [head, ''];
  for (const r of results) {
    const gap = r.gap ? ` — ${r.gap}` : '';
    const win = r.winner ? ` [A/B ${r.winner}]` : '';
    lines.push(`- ${r.label} (${r.id}): ${r.verdict} after ${r.rounds} round(s)${win}${gap}`);
  }
  return lines.join('\n');
}
