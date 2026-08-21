import { describe, expect, it } from 'vitest';
import { scheduleWaves, piecesCanRunInParallel } from '../../src/cli/gauntlet/schedule.js';
import type { GauntletPiece } from '../../src/cli/gauntlet/decompose.js';
import { assignBlindLabels, parseBlindWinner, qualityBarSection } from '../../src/cli/gauntlet/blind.js';

function piece(id: string, scope?: string[]): GauntletPiece {
  return { id, label: id, prompt: id, acceptance: [], ...(scope ? { scope } : {}) };
}

describe('scheduleWaves', () => {
  it('keeps unscope pieces sequential even when maxParallel > 1', () => {
    const waves = scheduleWaves([piece('a'), piece('b')], 2);
    expect(waves).toEqual([[piece('a')], [piece('b')]]);
  });

  it('pairs disjoint scopes in one wave', () => {
    const hud = piece('hud', ['src/hud.ts']);
    const ai = piece('ai', ['src/ai.ts']);
    expect(piecesCanRunInParallel(hud, ai)).toBe(true);
    const waves = scheduleWaves([hud, ai], 2);
    expect(waves).toHaveLength(1);
    expect(waves[0]?.map((p) => p.id)).toEqual(['hud', 'ai']);
  });

  it('does not pair overlapping scopes', () => {
    const a = piece('a', ['src/']);
    const b = piece('b', ['src/ai.ts']);
    const waves = scheduleWaves([a, b], 2);
    expect(waves).toHaveLength(2);
  });
});

describe('blind A/B', () => {
  it('shuffles according to rand', () => {
    const alwaysLow = assignBlindLabels(['gold.png', 'cand.png'], () => 0.1);
    expect(alwaysLow.A).toBe('gold.png');
    expect(alwaysLow.firstLabel).toBe('A');
    const alwaysHigh = assignBlindLabels(['gold.png', 'cand.png'], () => 0.9);
    expect(alwaysHigh.A).toBe('cand.png');
    expect(alwaysHigh.firstLabel).toBe('B');
  });

  it('emits a single-bar quality section without A/B', () => {
    const s = qualityBarSection(['refs/gold.html']);
    expect(s).toMatch(/Quality bar/);
    expect(s).not.toMatch(/Blind A\/B/);
    expect(s).toContain('refs/gold.html');
  });

  it('parses WINNER trailer', () => {
    expect(parseBlindWinner('WINNER: B\nVERDICT: PASS')).toBe('B');
    expect(parseBlindWinner('nope')).toBeUndefined();
  });
});
