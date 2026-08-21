import { describe, expect, it } from 'vitest';
import {
  formatGauntletElapsed,
  readGauntletProgress,
} from '../../apps/desktop/src/components/GauntletProgressCard';
import { formatRunElapsed } from '../../apps/desktop/src/components/RunActivity';

describe('readGauntletProgress', () => {
  it('accepts a well-formed payload and rejects junk', () => {
    expect(readGauntletProgress({ type: 'gauntlet_progress' })).toBeNull();
    const view = readGauntletProgress({
      type: 'gauntlet_progress',
      progress: {
        phase: 'critiquing',
        pieceId: 'g1',
        pieceLabel: 'HUD',
        pieceIndex: 0,
        pieceCount: 1,
        round: 2,
        maxRounds: 3,
        verdict: 'GAP',
        gap: 'no timer',
        winner: 'B',
        elapsedMs: 125000,
      },
    });
    expect(view?.phase).toBe('critiquing');
    expect(view?.verdict).toBe('GAP');
    expect(view?.winner).toBe('B');
    expect(formatGauntletElapsed(view!.elapsedMs)).toBe('2m 5s');
  });

  it('accepts decompose progress at round 0', () => {
    const view = readGauntletProgress({
      progress: {
        phase: 'decomposing',
        pieceId: '',
        pieceLabel: 'Goal',
        pieceIndex: 0,
        pieceCount: 1,
        round: 0,
        maxRounds: 3,
        elapsedMs: 0,
      },
    });
    expect(view?.phase).toBe('decomposing');
    expect(view?.round).toBe(0);
  });
});

describe('formatRunElapsed', () => {
  it('formats seconds and minutes', () => {
    expect(formatRunElapsed(900)).toBe('0s');
    expect(formatRunElapsed(12_000)).toBe('12s');
    expect(formatRunElapsed(125_000)).toBe('2m 5s');
  });
});
