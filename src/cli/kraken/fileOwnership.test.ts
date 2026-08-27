/**
 * fileOwnership.test.ts — P2.A pure coverage.
 *
 * The overlap matrix (wildcard writer, disjoint, ancestor containment,
 * catch-all, missing scopes, same-path different-glob, case folding) and the
 * arbitration contract (greedy, order-stable, deferred-not-failed). No fs,
 * no env — the module under test is pure by contract and stays testable
 * exactly because of it.
 */

import { describe, expect, it } from 'vitest';
import {
  arbitrateAdmission,
  caseInsensitiveFs,
  globsOverlap,
  hasWriteOverlap,
  normalizeGlob,
  writeScopeOf,
  type OwnershipNode,
} from './fileOwnership.js';

function node(id: string, kind: string, scope?: string[]): OwnershipNode {
  return { id, kind, ...(scope ? { scope } : {}) };
}

describe('writeScopeOf', () => {
  it('treats explore/verify (and reviewer personas) as read-only — never a write scope', () => {
    for (const kind of ['explore', 'verify', 'spec', 'conformance']) {
      expect(writeScopeOf(node('n', kind, ['src/**']))).toBeNull();
      expect(writeScopeOf(node('n', kind))).toBeNull();
    }
  });

  it('a general writer with NO scope is a wildcard writer', () => {
    expect(writeScopeOf(node('g', 'general'))).toEqual(['**']);
    expect(writeScopeOf(node('g', 'general', []))).toEqual(['**']);
  });

  it('normalizes separators, ./ prefixes, duplicate and trailing slashes', () => {
    expect(writeScopeOf(node('g', 'general', ['.\\src\\auth\\']))).toEqual(['src/auth']);
    expect(writeScopeOf(node('g', 'general', ['./src//auth']))).toEqual(['src/auth']);
  });

  it('a scope of only whole-tree dots collapses to wildcards', () => {
    expect(writeScopeOf(node('g', 'general', ['.', '.']))).toEqual(['**', '**']);
  });

  it('fix and merge nodes are writers; an unknown kind is conservatively a writer', () => {
    expect(writeScopeOf(node('f', 'fix', ['src/a']))).toEqual(['src/a']);
    expect(writeScopeOf(node('m', 'merge'))).toEqual(['**']);
    expect(writeScopeOf(node('x', 'something-new'))).toEqual(['**']);
  });
});

describe('globsOverlap', () => {
  it('identical globs overlap', () => {
    expect(globsOverlap('src/auth', 'src/auth')).toBe(true);
  });

  it('distinct literal paths do not overlap (no accidental prefix eating)', () => {
    expect(globsOverlap('src/auth', 'src/authz')).toBe(false);
    expect(globsOverlap('src/a/x.ts', 'src/b/x.ts')).toBe(false);
  });

  it('ancestor containment overlaps: src/** vs src/a/**', () => {
    expect(globsOverlap('src/**', 'src/a/**')).toBe(true);
    expect(globsOverlap('src', 'src/auth/jwt.ts')).toBe(true);
  });

  it('the ** catch-all overlaps anything', () => {
    expect(globsOverlap('**', 'src/a/x.ts')).toBe(true);
    expect(globsOverlap('**', '**')).toBe(true);
  });

  it('same path, different globs still share concrete matches', () => {
    expect(globsOverlap('src/a/**', 'src/a/*.ts')).toBe(true);
    expect(globsOverlap('src/*.ts', 'src/a/b.ts')).toBe(true); // `*` crosses `/` (policyEngine convention)
  });

  it('different wildcard tails that cannot agree on a literal stay disjoint', () => {
    expect(globsOverlap('src/a*b', 'src/a*c')).toBe(false);
    expect(globsOverlap('src/*.ts', 'src/*.md')).toBe(false);
    // ...but can agree when a shared concrete match exists ("ab" satisfies both).
    expect(globsOverlap('src/a*', 'src/*b')).toBe(true);
  });

  it('folds case only when asked (win32/darwin FSes)', () => {
    expect(globsOverlap('SRC/**', 'src/**', true)).toBe(true);
    expect(globsOverlap('SRC/**', 'src/**', false)).toBe(false);
  });
});

describe('hasWriteOverlap', () => {
  it('read-only nodes never conflict, even against a wildcard writer', () => {
    expect(hasWriteOverlap(node('e', 'explore'), node('g', 'general'))).toBe(false);
    expect(hasWriteOverlap(node('v', 'verify', ['**']), node('g', 'general', ['**']))).toBe(false);
  });

  it('two writers with missing scopes on both sides conflict', () => {
    expect(hasWriteOverlap(node('a', 'general'), node('b', 'general'))).toBe(true);
  });

  it('missing scope on one side conflicts with any writer scope', () => {
    expect(hasWriteOverlap(node('a', 'general'), node('b', 'general', ['src/a']))).toBe(true);
  });

  it('declared disjoint scopes do not conflict', () => {
    expect(hasWriteOverlap(node('a', 'general', ['src/a/**']), node('b', 'general', ['src/b/**']))).toBe(false);
  });

  it('nested scopes conflict (src/** contains src/a/**)', () => {
    expect(hasWriteOverlap(node('a', 'general', ['src/**']), node('b', 'general', ['src/a/**']))).toBe(true);
  });

  it('plumbs the case-folding option', () => {
    const a = node('a', 'general', ['SRC/api']);
    const b = node('b', 'general', ['src/api']);
    expect(hasWriteOverlap(a, b, { caseInsensitive: true })).toBe(true);
    expect(hasWriteOverlap(a, b, { caseInsensitive: false })).toBe(false);
  });

  it('any overlapping pair inside multi-glob scopes conflicts', () => {
    const a = node('a', 'general', ['docs/**', 'src/auth/**']);
    const b = node('b', 'general', ['src/auth/jwt.ts', 'tests/**']);
    expect(hasWriteOverlap(a, b)).toBe(true);
  });
});

describe('arbitrateAdmission', () => {
  it('admits in order and defers (not fails) the overlapping writer', () => {
    const a = node('a', 'general', ['src/api']);
    const b = node('b', 'general', ['src/api/**']);
    const c = node('c', 'general', ['src/tests']);
    const { admitted, deferred } = arbitrateAdmission([a, b, c]);
    expect(admitted.map((n) => n.id)).toEqual(['a', 'c']);
    expect(deferred.map((n) => n.id)).toEqual(['b']);
    // Deferred, not failed: the very same node object comes back, untouched.
    expect(deferred[0]).toBe(b);
  });

  it('is order-stable: a deferred writer does not block later disjoint ones', () => {
    const a = node('a', 'general', ['src/**']);
    const b = node('b', 'general', ['src/a/**']);
    const c = node('c', 'general', ['docs/**']);
    expect(arbitrateAdmission([a, b, c]).admitted.map((n) => n.id)).toEqual(['a', 'c']);
    // Same graph, different admission order: b now wins, a defers.
    expect(arbitrateAdmission([b, a, c]).admitted.map((n) => n.id)).toEqual(['b', 'c']);
  });

  it('defers writers overlapping an in-flight writer, admits disjoint ones', () => {
    const running = [node('r', 'general', ['src/api/**'])];
    const a = node('a', 'general', ['src/api/jwt.ts']);
    const b = node('b', 'general', ['src/ui']);
    expect(arbitrateAdmission([a, b], running).admitted.map((n) => n.id)).toEqual(['b']);
  });

  it('read-only candidates are always admissible, even against wildcard writers', () => {
    const running = [node('r', 'general')];
    const e = node('e', 'explore');
    const g = node('g', 'general');
    const { admitted, deferred } = arbitrateAdmission([e, g], running);
    expect(admitted.map((n) => n.id)).toEqual(['e']);
    expect(deferred.map((n) => n.id)).toEqual(['g']);
  });

  it('two wildcard writers never share a round', () => {
    const { admitted, deferred } = arbitrateAdmission([node('a', 'general'), node('b', 'general')]);
    expect(admitted).toHaveLength(1);
    expect(deferred).toHaveLength(1);
  });

  it('respects the case-folding option end to end', () => {
    const a = node('a', 'general', ['SRC/api']);
    const b = node('b', 'general', ['src/api']);
    expect(arbitrateAdmission([a, b], [], { caseInsensitive: true }).admitted).toHaveLength(1);
    expect(arbitrateAdmission([a, b], [], { caseInsensitive: false }).admitted).toHaveLength(2);
  });

  it('with no in-flight writers and a single candidate, nothing is deferred', () => {
    const g = node('g', 'general', ['src/**']);
    expect(arbitrateAdmission([g], []).deferred).toEqual([]);
  });
});

describe('platform helper', () => {
  it('matches the sandboxPath case-folding platform set', () => {
    expect(caseInsensitiveFs('win32')).toBe(true);
    expect(caseInsensitiveFs('darwin')).toBe(true);
    expect(caseInsensitiveFs('linux')).toBe(false);
  });
});
