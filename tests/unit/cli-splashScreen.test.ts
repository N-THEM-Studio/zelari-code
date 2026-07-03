/**
 * cli-splashScreen.test.ts — pure helpers of the startup splash (v0.7.8).
 *
 * The splash shows the downscaled N-THEM/Zelari ASCII emblem for ~2s at
 * startup, then gives way to the App. These tests pin the sizing and
 * gating logic (pickSplashArt / shouldShowSplash) — the Ink rendering
 * itself is intentionally not tested (no ink-testing-library dep).
 */
import { describe, it, expect } from 'vitest';
import {
  pickSplashArt,
  shouldShowSplash,
  SPLASH_DURATION_MS,
} from '../../src/cli/components/SplashScreen.js';

describe('pickSplashArt — variant sizing', () => {
  it('picks the large emblem on a roomy terminal (120×50)', () => {
    const art = pickSplashArt(120, 50);
    expect(art).not.toBeNull();
    expect(art!.width).toBeGreaterThan(50); // large variant is ~64 cols
    expect(art!.height + 5).toBeLessThanOrEqual(50);
  });

  it('falls back to the small emblem on a standard 80×35 terminal', () => {
    const art = pickSplashArt(80, 35);
    expect(art).not.toBeNull();
    expect(art!.width).toBeLessThanOrEqual(50); // small variant is ~44 cols
    expect(art!.height + 5).toBeLessThanOrEqual(35);
  });

  it('returns null when even the small emblem does not fit (80×20)', () => {
    expect(pickSplashArt(80, 20)).toBeNull();
  });

  it('returns null on a very narrow terminal (40 cols)', () => {
    expect(pickSplashArt(40, 50)).toBeNull();
  });

  it('every variant line fits its declared width', () => {
    const art = pickSplashArt(200, 200)!;
    for (const line of art.art.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(art.width);
    }
  });
});

describe('shouldShowSplash — gating', () => {
  const roomy = { isTTY: true, env: {}, columns: 120, rows: 50 };

  it('shows on an interactive roomy terminal', () => {
    expect(shouldShowSplash(roomy)).toBe(true);
  });

  it('skips when stdout is not a TTY (pipes, CI)', () => {
    expect(shouldShowSplash({ ...roomy, isTTY: false })).toBe(false);
  });

  it('skips when ZELARI_NO_SPLASH=1', () => {
    expect(shouldShowSplash({ ...roomy, env: { ZELARI_NO_SPLASH: '1' } })).toBe(false);
  });

  it('skips when the terminal is too small', () => {
    expect(shouldShowSplash({ ...roomy, columns: 40, rows: 15 })).toBe(false);
  });
});

describe('splash duration', () => {
  it('auto-dismisses in ~2s (bounded so startup never feels stuck)', () => {
    expect(SPLASH_DURATION_MS).toBeGreaterThanOrEqual(1000);
    expect(SPLASH_DURATION_MS).toBeLessThanOrEqual(4000);
  });
});
