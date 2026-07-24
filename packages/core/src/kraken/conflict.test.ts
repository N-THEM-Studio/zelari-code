import { describe, it, expect } from 'vitest';
import {
  normalizeScopePath,
  pathsOverlap,
  disjointScopeSets,
  canRunParallel,
  selectParallelWave,
} from './conflict.js';
import type { TaskNode, TaskNodeKind } from './graph.js';

function node(
  id: string,
  kind: TaskNodeKind = 'general',
  scope?: string[],
): TaskNode {
  return {
    id,
    kind,
    label: id,
    prompt: `do ${id}`,
    ...(scope ? { scope } : {}),
    deps: [],
    status: 'pending',
    retryCount: 0,
    maxRetries: 2,
  };
}

describe('normalizeScopePath', () => {
  it('strips ./ and trailing slash, converts backslashes', () => {
    expect(normalizeScopePath('.\\src\\auth\\')).toBe('src/auth');
    expect(normalizeScopePath('./src/auth/')).toBe('src/auth');
    expect(normalizeScopePath('src//auth')).toBe('src/auth');
  });
});

describe('pathsOverlap', () => {
  it('identical paths overlap', () => {
    expect(pathsOverlap('src/auth', 'src/auth')).toBe(true);
  });

  it('ancestor directory overlaps a descendant file', () => {
    expect(pathsOverlap('src/auth', 'src/auth/jwt.ts')).toBe(true);
    expect(pathsOverlap('src/auth/jwt.ts', 'src/auth')).toBe(true);
  });

  it('sibling dirs with a shared string prefix do NOT overlap', () => {
    // segment-wise: "auth" !== "authz"
    expect(pathsOverlap('src/auth', 'src/authz')).toBe(false);
    expect(pathsOverlap('src/auth', 'src/authority/x.ts')).toBe(false);
  });

  it('distinct subtrees do NOT overlap', () => {
    expect(pathsOverlap('src/auth', 'src/middleware')).toBe(false);
  });

  it('globstar overlaps anything below', () => {
    expect(pathsOverlap('src/**', 'src/auth/jwt.ts')).toBe(true);
    expect(pathsOverlap('src/auth/**', 'src/middleware/x.ts')).toBe(false);
  });

  it('single-segment wildcard matches a literal segment', () => {
    expect(pathsOverlap('src/*/rate.ts', 'src/middleware/rate.ts')).toBe(true);
    expect(pathsOverlap('src/*/rate.ts', 'src/middleware/valid.ts')).toBe(false);
  });

  it('a glob segment overlapping a literal filename overlaps', () => {
    // `src/*/*.ts` can match the same file as `src/*/a.ts` (e.g. src/x/a.ts).
    expect(pathsOverlap('src/*/*.ts', 'src/*/a.ts')).toBe(true);
  });

  it('distinct literal filenames under globs do NOT overlap', () => {
    // No single file is both `a.ts` and `b.ts` → genuinely disjoint.
    expect(pathsOverlap('src/*/a.ts', 'src/*/b.ts')).toBe(false);
  });

  it('root/empty scopes overlap everything', () => {
    expect(pathsOverlap('', '')).toBe(true);
    expect(pathsOverlap('.', 'src/auth')).toBe(true);
  });
});

describe('disjointScopeSets', () => {
  it('true for provably disjoint scopes', () => {
    expect(disjointScopeSets(['src/auth/**'], ['src/middleware/**'])).toBe(true);
  });

  it('false when any pair overlaps', () => {
    expect(
      disjointScopeSets(['src/auth/**', 'src/shared/**'], ['src/shared/util.ts']),
    ).toBe(false);
  });

  it('false when a scope is missing/empty (whole tree)', () => {
    expect(disjointScopeSets(undefined, ['src/auth'])).toBe(false);
    expect(disjointScopeSets(['src/auth'], [])).toBe(false);
  });
});

describe('canRunParallel', () => {
  it('read-only kinds are always parallel-safe', () => {
    expect(canRunParallel(node('e', 'explore'), node('g', 'general', ['src/x']))).toBe(true);
    expect(canRunParallel(node('v', 'verify'), node('g', 'general'))).toBe(true);
    expect(canRunParallel(node('e1', 'explore'), node('e2', 'explore'))).toBe(true);
  });

  it('writers with disjoint scopes run in parallel', () => {
    expect(
      canRunParallel(
        node('g1', 'general', ['src/auth/**']),
        node('g2', 'general', ['src/middleware/**']),
      ),
    ).toBe(true);
  });

  it('writers with overlapping scopes do NOT run in parallel', () => {
    expect(
      canRunParallel(
        node('g1', 'general', ['src/**']),
        node('g2', 'general', ['src/auth/jwt.ts']),
      ),
    ).toBe(false);
  });

  it('a writer without a scope is conservative (not parallel)', () => {
    expect(canRunParallel(node('g1', 'general'), node('g2', 'general', ['src/x']))).toBe(false);
    expect(canRunParallel(node('f1', 'fix'), node('f2', 'fix'))).toBe(false);
  });

  it('merge nodes never run in parallel', () => {
    expect(canRunParallel(node('m', 'merge'), node('e', 'explore'))).toBe(false);
    expect(canRunParallel(node('g', 'general', ['src/x']), node('m', 'merge'))).toBe(false);
  });
});

describe('selectParallelWave', () => {
  it('returns the maximal mutually-parallel prefix', () => {
    const candidates = [
      node('g1', 'general', ['src/auth/**']),
      node('g2', 'general', ['src/middleware/**']),
      node('g3', 'general', ['src/auth/jwt.ts']), // overlaps g1 → excluded
      node('e1', 'explore'), // read-only → always fits
    ];
    const wave = selectParallelWave(candidates).map((n) => n.id);
    expect(wave).toEqual(['g1', 'g2', 'e1']);
  });

  it('empty input → empty wave', () => {
    expect(selectParallelWave([])).toEqual([]);
  });
});
