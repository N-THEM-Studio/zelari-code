/**
 * worktreeScheduling.test.ts — P2.C pure coverage.
 *
 * The overlap-score matrix (identical / nested / disjoint / mixed / wildcard /
 * case folding), the classification bands, the env-value grammar and the
 * decision policy. No fs, no process.env — the module under test is pure by
 * contract, so every case passes its inputs explicitly.
 */

import { describe, expect, it } from 'vitest';
import {
  OVERLAP_HIGH_THRESHOLD,
  OVERLAP_LOW_THRESHOLD,
  classifyOverlap,
  estimateOverlapScore,
  isWorktreeCapableKind,
  resolveWorktreeMode,
  worktreeSchedulingDecision,
  type OwnershipNode,
} from './worktreeScheduling.js';

function node(id: string, kind: string, scope?: string[]): OwnershipNode {
  return { id, kind, ...(scope ? { scope } : {}) };
}

const auto = { ZELARI_KRAKEN_WORKTREE: 'auto' };

describe('estimateOverlapScore', () => {
  it('identical globs score 1', () => {
    expect(estimateOverlapScore(['src/api/**'], ['src/api/**'])).toBe(1);
  });

  it('globs identical only up to case score 1 when the FS folds case, 0 when it does not', () => {
    expect(estimateOverlapScore(['SRC/api/**'], ['src/api/**'])).toBe(1);
    expect(estimateOverlapScore(['SRC/api/**'], ['src/api/**'], { caseInsensitive: false })).toBe(0);
  });

  it('nested (ancestor containment) scores the partial rung', () => {
    expect(estimateOverlapScore(['src/api'], ['src/api/jwt.ts'])).toBe(0.5);
    expect(estimateOverlapScore(['src/**'], ['src/api/x.ts'])).toBe(0.5);
  });

  it('a wildcard claim scores the partial rung against anything concrete', () => {
    expect(estimateOverlapScore(['**'], ['docs/readme.md'])).toBe(0.5);
  });

  it('cross-segment globs (`*` also crosses `/`) score the partial rung', () => {
    expect(estimateOverlapScore(['src/*.ts'], ['src/a/b.ts'])).toBe(0.5);
  });

  it('disjoint scopes score 0 — including at the segment boundary', () => {
    expect(estimateOverlapScore(['src/a/**'], ['docs/b/**'])).toBe(0);
    expect(estimateOverlapScore(['src/auth'], ['src/authz'])).toBe(0);
  });

  it('mixed scope sets take the max over all pairs', () => {
    expect(estimateOverlapScore(['docs/**'], ['src/a/**', 'docs/b/**'])).toBe(0.5);
    expect(estimateOverlapScore(['docs/x.md', 'src/a'], ['src/a'])).toBe(1);
    expect(estimateOverlapScore(['docs/x.md', 'src/a'], ['lib/b'])).toBe(0);
  });

  it('empty scope sets overlap nothing', () => {
    expect(estimateOverlapScore([], ['src/**'])).toBe(0);
    expect(estimateOverlapScore([], [])).toBe(0);
  });
});

describe('classifyOverlap', () => {
  it('bands: below LOW → disjoint, [LOW, HIGH) → low, ≥ HIGH → high', () => {
    expect(classifyOverlap(0)).toBe('disjoint');
    expect(classifyOverlap(OVERLAP_LOW_THRESHOLD - 0.01)).toBe('disjoint');
    expect(classifyOverlap(OVERLAP_LOW_THRESHOLD)).toBe('low');
    expect(classifyOverlap(0.6)).toBe('low');
    expect(classifyOverlap(OVERLAP_HIGH_THRESHOLD - 0.01)).toBe('low');
    expect(classifyOverlap(OVERLAP_HIGH_THRESHOLD)).toBe('high');
    expect(classifyOverlap(1)).toBe('high');
  });

  it('the partial rung (0.5) classifies low — the band the scheduler acts on', () => {
    // A deferred writer always overlaps a racing one (score ≥ 0.5), so the
    // actionable 'low' band must start at the partial rung.
    expect(classifyOverlap(0.5)).toBe('low');
  });
});

describe('resolveWorktreeMode', () => {
  it('undefined / empty / 0 → off (today’s behavior)', () => {
    expect(resolveWorktreeMode(undefined)).toBe('off');
    expect(resolveWorktreeMode('')).toBe('off');
    expect(resolveWorktreeMode('0')).toBe('off');
  });

  it('1 / true → on; auto → auto (case- and whitespace-tolerant)', () => {
    expect(resolveWorktreeMode('1')).toBe('on');
    expect(resolveWorktreeMode('true')).toBe('on');
    expect(resolveWorktreeMode('auto')).toBe('auto');
    expect(resolveWorktreeMode('AUTO')).toBe('auto');
    expect(resolveWorktreeMode('  auto  ')).toBe('auto');
  });

  it('anything else falls back to off — never widen parallelism on garbage', () => {
    expect(resolveWorktreeMode('garbage')).toBe('off');
    expect(resolveWorktreeMode('2')).toBe('off');
    expect(resolveWorktreeMode('false')).toBe('off');
    expect(resolveWorktreeMode('yes')).toBe('off');
    expect(resolveWorktreeMode('on')).toBe('off');
  });
});

describe('isWorktreeCapableKind', () => {
  it('general and fix are capable; readers, merge and unknown kinds are not', () => {
    expect(isWorktreeCapableKind('general')).toBe(true);
    expect(isWorktreeCapableKind('fix')).toBe(true);
    expect(isWorktreeCapableKind('explore')).toBe(false);
    expect(isWorktreeCapableKind('verify')).toBe(false);
    expect(isWorktreeCapableKind('merge')).toBe(false);
    expect(isWorktreeCapableKind('rework')).toBe(false);
  });
});

describe('worktreeSchedulingDecision', () => {
  it('defers defensively when the mode is not auto (off and on alike)', () => {
    for (const env of [{}, { ZELARI_KRAKEN_WORKTREE: '' }, { ZELARI_KRAKEN_WORKTREE: '0' }, { ZELARI_KRAKEN_WORKTREE: '1' }]) {
      const d = worktreeSchedulingDecision(
        node('g2', 'general', ['src/api/jwt.ts']),
        [node('g1', 'general', ['src/api'])],
        env,
      );
      expect(d.mode).toBe('defer');
      expect(d.rationaleCode).toBe('worktree-mode-not-auto');
    }
  });

  it('auto + nested (low) overlap → parallel-worktree with score, rationale and best match', () => {
    const d = worktreeSchedulingDecision(
      node('g2', 'general', ['src/api/jwt.ts']),
      [node('g1', 'general', ['src/api'])],
      auto,
    );
    expect(d.mode).toBe('parallel-worktree');
    expect(d.overlapScore).toBe(0.5);
    expect(d.rationaleCode).toBe('low-overlap-worktree');
    expect(d.bestMatchId).toBe('g1');
  });

  it('auto + identical (high) overlap → keep the sequential deferral', () => {
    const d = worktreeSchedulingDecision(
      node('g2', 'general', ['src/api']),
      [node('g1', 'general', ['src/api'])],
      auto,
    );
    expect(d.mode).toBe('defer');
    expect(d.overlapScore).toBe(1);
    expect(d.rationaleCode).toBe('high-overlap');
    expect(d.bestMatchId).toBe('g1');
  });

  it('auto + no racing writer overlap → plain-parallel, nothing to isolate', () => {
    const d = worktreeSchedulingDecision(
      node('g2', 'general', ['docs/**']),
      [node('g1', 'general', ['src/**'])],
      auto,
    );
    expect(d.mode).toBe('plain-parallel');
    expect(d.overlapScore).toBe(0);
    expect(d.rationaleCode).toBe('no-racing-overlap');
  });

  it('auto + read-only node → defer (arbitration never defers these; say so anyway)', () => {
    for (const kind of ['explore', 'verify']) {
      const d = worktreeSchedulingDecision(
        node('v1', kind, ['src/api']),
        [node('g1', 'general', ['src/api'])],
        auto,
      );
      expect(d.mode).toBe('defer');
      expect(d.rationaleCode).toBe('read-only-node');
    }
  });

  it('auto + kind that cannot be worktree-isolated → defer', () => {
    const d = worktreeSchedulingDecision(
      node('m1', 'merge'),
      [node('g1', 'general', ['src/**'])],
      auto,
    );
    expect(d.mode).toBe('defer');
    expect(d.rationaleCode).toBe('kind-not-worktree-capable');
  });

  it('auto + wildcard writer racing a scoped writer scores the partial rung → admit isolated', () => {
    const d = worktreeSchedulingDecision(
      node('g2', 'general'),
      [node('g1', 'general', ['src/api/**'])],
      auto,
    );
    expect(d.mode).toBe('parallel-worktree');
    expect(d.overlapScore).toBe(0.5);
  });
});
