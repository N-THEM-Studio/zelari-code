/**
 * Parallel waves: two pieces run together only when both declare scopes
 * and those scopes are provably disjoint (same rule as Kraken writers).
 */
import { disjointScopeSets } from '@zelari/core';
import type { GauntletPiece } from './decompose.js';

export function piecesCanRunInParallel(a: GauntletPiece, b: GauntletPiece): boolean {
  return disjointScopeSets(a.scope, b.scope);
}

/** Greedy first-fit waves, capped at maxParallel. */
export function scheduleWaves(
  pieces: readonly GauntletPiece[],
  maxParallel: number,
): GauntletPiece[][] {
  const cap = Math.max(1, maxParallel);
  const remaining = [...pieces];
  const waves: GauntletPiece[][] = [];
  while (remaining.length > 0) {
    const wave: GauntletPiece[] = [];
    const leftover: GauntletPiece[] = [];
    for (const p of remaining) {
      if (wave.length >= cap) {
        leftover.push(p);
        continue;
      }
      if (wave.length === 0 || wave.every((w) => piecesCanRunInParallel(w, p))) {
        wave.push(p);
      } else {
        leftover.push(p);
      }
    }
    waves.push(wave);
    remaining.splice(0, remaining.length, ...leftover);
  }
  return waves;
}
