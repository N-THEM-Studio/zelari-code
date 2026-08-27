/**
 * spawnRoi unit tests (t30 / §17): pinned score math for regression, no-NaN
 * on unknown inputs, threshold env parsing, duplication-risk matrix and the
 * shouldSpawn boundary. Tests pin BEHAVIOR (ratios, orderings, lattice
 * values), not incidental floating-point tails — comparisons use toBeCloseTo.
 */

import { describe, expect, it } from 'vitest';
import {
  COST_SCALE,
  DEFAULT_COST_NORM,
  DEFAULT_LATENCY_NORM,
  DEFAULT_VERIFIED_RATE,
  KIND_WEIGHTS,
  REPAIR_PENALTY,
  SPAWN_SCORE_THRESHOLD,
  computeSpawnScore,
  duplicationRiskFor,
  parseRoiThreshold,
  shouldSpawn,
  type SpawnRoiInput,
} from './spawnRoi.js';

/** Every optional signal unknown — the "no data at all" shape. */
function allNullInput(over: Partial<SpawnRoiInput> = {}): SpawnRoiInput {
  return {
    reputationSample: 0,
    verifiedRate: null,
    historicalAvgRepairs: null,
    estimatedTokens: null,
    costUsdPer1k: null,
    latencyMsEstimate: null,
    duplicationRisk: 0,
    taskKind: 'explore',
    ...over,
  };
}

describe('computeSpawnScore', () => {
  it('perfect reputation + cheap estimates: pinned high score, spawns', () => {
    const r = computeSpawnScore({
      reputationSample: 12,
      verifiedRate: 1,
      historicalAvgRepairs: 0,
      estimatedTokens: 50_000,
      costUsdPer1k: 0.001, // $1/M ⇒ $0.05 for the run
      latencyMsEstimate: 60_000,
      duplicationRisk: 0,
      taskKind: 'explore',
    });
    expect(r.components.gain).toBe(1);
    // money = $0.05 / $0.10 = 0.5; latency = 60s / 5min = 0.2; dup 0.
    expect(r.components.cost).toBeCloseTo(0.7, 10);
    expect(r.score).toBeCloseTo(1 / 0.7, 9);
    expect(r.rationaleCode).toBe('roi-reputation-backed');
    expect(shouldSpawn(r)).toBe(true);
  });

  it('all-null inputs: sane finite default score (≈ 0.324) that SPAWNS', () => {
    const r = computeSpawnScore(allNullInput());
    expect(Number.isNaN(r.score)).toBe(false);
    expect(Number.isFinite(r.score)).toBe(true);
    // gain = 0.7 * (1 - 0.15 * 0.5) * 1.0 = 0.6475
    expect(r.components.gain).toBeCloseTo(
      DEFAULT_VERIFIED_RATE * (1 + REPAIR_PENALTY * 0.5) * KIND_WEIGHTS.explore,
      12,
    );
    expect(r.components.cost).toBeCloseTo(DEFAULT_COST_NORM + DEFAULT_LATENCY_NORM, 12);
    expect(r.score).toBeCloseTo(0.32375, 10);
    expect(r.rationaleCode).toBe('roi-defaults');
    // Calibration: unknown ⇒ spawn (fail-open advisor).
    expect(shouldSpawn(r)).toBe(true);
  });

  it('garbage numeric fields (NaN/Infinity) behave exactly as unknown — no NaN', () => {
    const r = computeSpawnScore({
      reputationSample: Number.NaN,
      verifiedRate: Number.NaN,
      historicalAvgRepairs: Number.NEGATIVE_INFINITY,
      estimatedTokens: Number.NaN,
      costUsdPer1k: Number.POSITIVE_INFINITY,
      latencyMsEstimate: Number.NaN,
      duplicationRisk: 0,
      taskKind: 'implement',
    });
    const baseline = computeSpawnScore(allNullInput({ taskKind: 'implement' }));
    expect(Number.isFinite(r.score)).toBe(true);
    expect(r.score).toBe(baseline.score);
    expect(r.rationaleCode).toBe(baseline.rationaleCode);
  });

  it('high-cost scenario: runaway money+latency+duplication drives the score to a veto', () => {
    const r = computeSpawnScore({
      reputationSample: 9,
      verifiedRate: 0.2,
      historicalAvgRepairs: 3,
      estimatedTokens: 5_000_000,
      costUsdPer1k: 0.015, // $15/M ⇒ $75 for the run
      latencyMsEstimate: 600_000, // 2 cost units
      duplicationRisk: 0.5,
      taskKind: 'implement',
    });
    // gain = 0.2 * max(0.3, 1 - 0.45) * 1.0 = 0.11
    expect(r.components.gain).toBeCloseTo(0.11, 12);
    // cost = $75/0.1 = 750 cost units + 2 latency + 0.5 * COST_SCALE
    expect(r.components.cost).toBeCloseTo(750 + 2 + 0.5 * COST_SCALE, 8);
    expect(r.score).toBeLessThan(SPAWN_SCORE_THRESHOLD);
    expect(shouldSpawn(r)).toBe(false);
  });

  it('high duplication alone (risk 1) on unknown inputs still spawns — calibration', () => {
    const r = computeSpawnScore(allNullInput({ duplicationRisk: 1 }));
    // cost = 1 + 1 + 1 = 3 ⇒ score ≈ 0.216 > 0.15: the gate stays advisory on
    // unknown data; a duplication veto needs reputation-backed evidence too.
    expect(r.components.cost).toBeCloseTo(2 + COST_SCALE, 12);
    expect(shouldSpawn(r)).toBe(true);
  });

  it('kind weights order explore/implement ≥ verify ≥ review on identical inputs', () => {
    const scoreOf = (kind: SpawnRoiInput['taskKind']) =>
      computeSpawnScore(allNullInput({ taskKind: kind })).score;
    expect(scoreOf('explore')).toBe(scoreOf('implement'));
    expect(scoreOf('explore')).toBeGreaterThan(scoreOf('verify'));
    expect(scoreOf('verify')).toBeGreaterThan(scoreOf('review'));
  });

  it('repairs discount the gain and floored at REPAIR_FACTOR_FLOOR, never negative', () => {
    const gainFor = (repairs: number | null) =>
      computeSpawnScore(allNullInput({ historicalAvgRepairs: repairs, verifiedRate: 0.5 }))
        .components.gain;
    expect(gainFor(0)).toBeCloseTo(0.5, 12);
    expect(gainFor(1)).toBeLessThan(gainFor(0));
    expect(gainFor(100)).toBeCloseTo(0.5 * 0.3, 12); // floored, still positive
    expect(gainFor(null)).toBeCloseTo(0.5 * (1 + REPAIR_PENALTY * 0.5), 12);
  });
});

describe('parseRoiThreshold', () => {
  it('honors plain non-negative numbers, including 0 (veto off)', () => {
    expect(parseRoiThreshold('0.4')).toBe(0.4);
    expect(parseRoiThreshold('0')).toBe(0);
    expect(parseRoiThreshold(' 0.25 ')).toBe(0.25);
    expect(parseRoiThreshold('1')).toBe(1);
  });

  it('falls back to the default on undefined/empty/invalid/negative/non-finite', () => {
    for (const raw of [undefined, '', '   ', 'abc', 'not-a-number', '-1', 'NaN', 'Infinity']) {
      expect(parseRoiThreshold(raw)).toBe(SPAWN_SCORE_THRESHOLD);
    }
  });
});

describe('shouldSpawn boundary', () => {
  const probe = computeSpawnScore(allNullInput({ verifiedRate: 0.3, historicalAvgRepairs: 0 }));

  it('score == threshold spawns (ties go to the fail-open direction)', () => {
    expect(shouldSpawn(probe, probe.score)).toBe(true);
  });

  it('score just below the threshold vetoes', () => {
    expect(shouldSpawn(probe, probe.score + 1e-9)).toBe(false);
  });

  it('a garbage threshold spawns rather than vetoing', () => {
    expect(shouldSpawn(probe, Number.NaN)).toBe(true);
    expect(shouldSpawn(probe, Number.POSITIVE_INFINITY)).toBe(true);
  });
});

describe('duplicationRiskFor matrix', () => {
  const n = (id: string, kind: string, scope?: string[]) => ({ id, kind, scope });

  it('no racing nodes ⇒ 0', () => {
    expect(duplicationRiskFor(n('a', 'general', ['src/a']), [])).toBe(0);
  });

  it('disjoint scopes ⇒ 0 regardless of kind', () => {
    expect(
      duplicationRiskFor(n('a', 'general', ['src/a']), [n('b', 'general', ['src/b'])]),
    ).toBe(0);
    expect(
      duplicationRiskFor(n('a', 'explore', ['src/a']), [n('b', 'explore', ['src/b'])]),
    ).toBe(0);
  });

  it('read-only overlap ⇒ 0.25; identical read-only claim ⇒ 1', () => {
    expect(
      duplicationRiskFor(n('a', 'explore', ['src/api']), [n('b', 'explore', ['src/api/jwt.ts'])]),
    ).toBe(0.25);
    expect(
      duplicationRiskFor(n('a', 'verify', ['src/api']), [n('b', 'spec', ['SRC/api'])]),
    ).toBe(1); // case-folded identical claim
  });

  it('writer overlap (non-identical) ⇒ 0.5 — writer-vs-reader and writer-vs-writer alike', () => {
    expect(
      duplicationRiskFor(n('a', 'general', ['src/api']), [n('b', 'explore', ['src/api/x.ts'])]),
    ).toBe(0.5);
    expect(
      duplicationRiskFor(n('a', 'general', ['src/api']), [n('b', 'general', ['src/api/x.ts'])]),
    ).toBe(0.5);
  });

  it('identical normalized glob claim ⇒ 1 (near-certain duplicate)', () => {
    expect(
      duplicationRiskFor(n('a', 'general', ['src/api']), [n('b', 'general', ['src/api'])]),
    ).toBe(1);
    expect(
      duplicationRiskFor(n('a', 'general', ['SRC\\api']), [n('b', 'general', ['src/api'])]),
    ).toBe(1); // backslash + case normalized away
  });

  it('missing/empty scope claims the whole tree and collides accordingly', () => {
    expect(duplicationRiskFor(n('a', 'general'), [n('b', 'general', ['src/deep/x.ts'])])).toBe(0.5);
    expect(duplicationRiskFor(n('a', 'general'), [n('b', 'general')])).toBe(1); // both '**'
    expect(duplicationRiskFor(n('a', 'explore'), [n('b', 'explore')])).toBe(1);
  });

  it('excludes itself (same id) and takes the worst racer', () => {
    const self = n('a', 'general', ['src/api']);
    expect(
      duplicationRiskFor(self, [self, n('a', 'general', ['src/api'])]),
    ).toBe(0);
    expect(
      duplicationRiskFor(n('a', 'explore', ['src/x']), [
        n('b', 'explore', ['src/y']), // disjoint — ignored
        n('c', 'general', ['src/x/y.ts']), // overlapping (non-identical) writer — 0.5 wins
      ]),
    ).toBe(0.5);
  });
});
