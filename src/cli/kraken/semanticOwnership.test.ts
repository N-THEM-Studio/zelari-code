import { describe, it, expect } from 'vitest';
import {
  parseOwnedSymbol,
  symbolsDisjoint,
  semanticConflictDecision,
  type OwnedSymbol,
  type SemanticConflictCtx,
} from './semanticOwnership.js';

/** Stub extractor whose returned names are asserted against by the decision. */
function extractorWith(names: string[]): {
  fn: (file: string) => Promise<readonly string[] | null>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    fn: async (file: string) => {
      calls.push(file);
      return names;
    },
  };
}

describe('parseOwnedSymbol', () => {
  it('parses a plain symbol claim', () => {
    expect(parseOwnedSymbol('src/auth/service.ts#AuthService')).toEqual({
      file: 'src/auth/service.ts',
      symbol: 'AuthService',
    });
  });

  it('parses a method-level claim', () => {
    expect(parseOwnedSymbol('src/auth/service.ts#AuthService.login')).toEqual({
      file: 'src/auth/service.ts',
      symbol: 'AuthService.login',
    });
  });

  it('allows dotted file paths and trims outer whitespace', () => {
    expect(parseOwnedSymbol('  a.b/c.d.ts#Sym  ')).toEqual({ file: 'a.b/c.d.ts', symbol: 'Sym' });
  });

  it('rejects malformed specs', () => {
    for (const bad of [
      '',
      'src/a.ts', // no '#'
      '#Sym', // empty file
      'src/a.ts#', // empty symbol
      'src/a.ts#A#B', // second '#'
      'src/a.ts#A.B.C', // three dot-segments
      'src/a.ts#A.', // trailing dot segment
      'src/a.ts#.A', // leading empty segment
      'src/ .ts#Sym', // whitespace in file
      'src/a.ts#A B', // whitespace in symbol
    ]) {
      expect(parseOwnedSymbol(bad), `expected null for ${JSON.stringify(bad)}`).toBeNull();
    }
  });
});

describe('symbolsDisjoint', () => {
  const own = (file: string, symbol: string): OwnedSymbol => ({ file, symbol });

  it('same file, different symbols → true (the case P2.B exists for)', () => {
    expect(
      symbolsDisjoint([own('src/a.ts', 'AuthService.login')], [own('src/a.ts', 'Token.refresh')]),
    ).toBe(true);
  });

  it('same file, same symbol → false', () => {
    expect(symbolsDisjoint([own('src/a.ts', 'Auth')], [own('src/a.ts', 'Auth')])).toBe(false);
  });

  it('undeclared (empty) side → null', () => {
    expect(symbolsDisjoint([], [own('src/a.ts', 'Auth')])).toBeNull();
    expect(symbolsDisjoint([own('src/a.ts', 'Auth')], [])).toBeNull();
    expect(symbolsDisjoint([], [])).toBeNull();
  });

  it('cross-file claims → true', () => {
    expect(
      symbolsDisjoint([own('src/a.ts', 'Auth')], [own('src/b.ts', 'Auth')]),
    ).toBe(true);
  });

  it('folds path separators and case conservatively', () => {
    expect(symbolsDisjoint([own('SRC\\A.TS', 'Auth')], [own('src/a.ts', 'auth')])).toBe(false);
  });
});

describe('semanticConflictDecision', () => {
  const nodeA = { id: 'a', ownedSymbols: ['src/auth.ts#AuthService.login'] };
  const nodeB = { id: 'b', ownedSymbols: ['src/auth.ts#TokenService.refresh'] };
  const sameAsA = { id: 'c', ownedSymbols: ['src/auth.ts#AuthService.login'] };
  const supported: SemanticConflictCtx['astSupported'] = (f) => f.endsWith('.ts');

  it('undeclared claims conflict (honest default)', async () => {
    const d = await semanticConflictDecision({ id: 'a' }, nodeB);
    expect(d.conflict).toBe(true);
    expect(d.reasonCode).toBe('undeclared-symbols');
  });

  it('malformed specs conflict (fail-closed)', async () => {
    const d = await semanticConflictDecision(
      { id: 'a', ownedSymbols: ['src/auth.ts#A.B.C'] },
      nodeB,
    );
    expect(d).toEqual({ conflict: true, reasonCode: 'malformed-spec' });
  });

  it('same symbol → conflict', async () => {
    const d = await semanticConflictDecision(nodeA, sameAsA);
    expect(d.conflict).toBe(true);
    expect(d.reasonCode).toBe('symbol-intersects');
  });

  it('cross-file claims → no conflict, extractor never invoked', async () => {
    const ex = extractorWith([]);
    const d = await semanticConflictDecision(
      nodeA,
      { id: 'b', ownedSymbols: ['src/token.ts#AuthService.login'] },
      { extractSymbols: ex.fn, astSupported: supported },
    );
    expect(d).toEqual({ conflict: false, reasonCode: 'cross-file-disjoint' });
    expect(ex.calls).toEqual([]);
  });

  it('same-file disjoint + verifying extractor → symbol-disjoint with anchor', async () => {
    const ex = extractorWith(['AuthService', 'TokenService']);
    const d = await semanticConflictDecision(nodeA, nodeB, {
      extractSymbols: ex.fn,
      astSupported: supported,
    });
    expect(d.conflict).toBe(false);
    expect(d.reasonCode).toBe('symbol-disjoint');
    expect(d.contestedFile).toBe('src/auth.ts');
    expect(ex.calls).toEqual(['src/auth.ts']);
  });

  it('no extractor → spec-only comparison', async () => {
    const d = await semanticConflictDecision(nodeA, nodeB, {});
    expect(d.conflict).toBe(false);
    expect(d.reasonCode).toBe('symbol-disjoint-spec-only');
  });

  it('AST-unsupported file (ctx flag) → spec-only comparison', async () => {
    const ex = extractorWith([]);
    const d = await semanticConflictDecision(
      { id: 'a', ownedSymbols: ['src/auth.py#AuthService'] },
      { id: 'b', ownedSymbols: ['src/auth.py#TokenService'] },
      { extractSymbols: ex.fn, astSupported: supported },
    );
    expect(d).toEqual({
      conflict: false,
      reasonCode: 'symbol-disjoint-spec-only',
      contestedFile: 'src/auth.py',
    });
    expect(ex.calls).toEqual([]);
  });

  it('extractor failure (null) → conflict, fail-closed', async () => {
    const d = await semanticConflictDecision(nodeA, nodeB, {
      extractSymbols: async () => null,
      astSupported: supported,
    });
    expect(d).toEqual({ conflict: true, reasonCode: 'ast-extract-failed' });
  });

  it('extractor throw → conflict, fail-closed', async () => {
    const d = await semanticConflictDecision(nodeA, nodeB, {
      extractSymbols: async () => {
        throw new Error('boom');
      },
      astSupported: supported,
    });
    expect(d).toEqual({ conflict: true, reasonCode: 'ast-extract-failed' });
  });

  it('declared symbol missing from the AST → conflict', async () => {
    const d = await semanticConflictDecision(nodeA, nodeB, {
      extractSymbols: async () => ['SomethingElse'],
      astSupported: supported,
    });
    expect(d).toEqual({ conflict: true, reasonCode: 'symbol-not-found' });
  });
});
