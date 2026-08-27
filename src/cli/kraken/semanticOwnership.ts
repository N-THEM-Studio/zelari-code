/**
 * semanticOwnership.ts — P2.B: symbol-level write ownership (pure).
 *
 * t25 (fileOwnership) serializes ANY two writers whose scope globs overlap;
 * t27 (worktreeScheduling) rescues the thin-overlap cases under git worktree
 * isolation but keeps serializing identical-grain claims — two tentacles
 * targeting the SAME file still pay the full latency of the first. Yet the
 * planner often knows better than the glob: it can name the symbols each
 * writer owns (`src/auth/service.ts#AuthService.login`). When two same-file
 * writers declare DISJOINT symbols, the arbitration that t25 forces is pure
 * idling. This module owns that refinement as a pure decision:
 *
 *   - `parseOwnedSymbol(spec)` — the claim grammar `"<file>#<SymbolName>"` or
 *     `"<file>#<Symbol.method>"`. Anything else (no `#`, empty halves, a
 *     second `#`, whitespace inside, a third dot-segment) is malformed → null.
 *   - `symbolsDisjoint(a, b)` — null when EITHER side declares nothing
 *     (undeclared ⇒ treated as conflict by callers: the honest default —
 *     refusing to claim disjointness you did not verify), false when any
 *     file+symbol pair intersects, true when every pair is disjoint (same
 *     file, different symbols is the case this whole module exists to admit).
 *   - `semanticConflictDecision(a, b, ctx)` — the async admission question.
 *     Async because AST extraction may be needed to verify the claims.
 *
 * HONEST v1 LIMITS (do not oversell this): the decision is admission-time
 * symbol-disjointness over the planner's DECLARED claims. It does not prove
 * the tentacles will stay inside their declared symbols (no line-level
 * intra-file verification, no post-hoc diff attribution), and a claim naming a
 * file the AST cannot parse verifies as a failure, not a pass. Every
 * unverifiable case defers to the t25 sequential path: an unnecessary
 * serialization costs minutes, an under-serialized same-file race corrupts
 * the tree.
 *
 * PURE by contract: no fs, no env, no clock, no imports outside types +
 * stdlib. AST access is injected through `ctx.extractSymbols` /
 * `ctx.astSupported`; the executor wires the real extractor (ast/engine),
 * tests inject stubs. A throwing extractor is caught here and reported as
 * `ast-extract-failed` — fail-closed to sequential, never fail-open.
 *
 * @since v0.10.x — Kraken semantic ownership arbitration (P2.B / t26)
 */

/** One parsed ownership claim: `symbol` (a symbol or `Symbol.method`) in `file`. */
export interface OwnedSymbol {
  readonly file: string;
  readonly symbol: string;
}

/** Structural node shape — `TaskNode` from @zelari/core satisfies this. */
export interface SymbolOwnershipNode {
  readonly id: string;
  /** Ownership claims in the `"<file>#<Symbol>"` grammar; undeclared = no claim. */
  readonly ownedSymbols?: readonly string[];
}

/** Injected AST access. Both optional: without them the decision is spec-only. */
export interface SemanticConflictCtx {
  /**
   * Extract the declared symbol names of `file`. `null` = extraction failed
   * (unsupported file, parse error, IO error) ⇒ the caller must defer.
   * The executor gates this on `isAstSupported` and only invokes it when both
   * sides declare claims, so a run never pays for parsing it cannot use.
   */
  extractSymbols?: (file: string) => Promise<readonly string[] | null>;
  /**
   * `isAstSupported(file)` semantics, injected so this module does not import
   * the AST engine. False (or absent) ⇒ spec-based comparison only.
   */
  astSupported?: (file: string) => boolean;
}

export type SemanticReasonCode =
  | 'undeclared-symbols'
  | 'malformed-spec'
  | 'symbol-intersects'
  | 'ast-extract-failed'
  | 'symbol-not-found'
  | 'symbol-disjoint'
  | 'symbol-disjoint-spec-only'
  | 'cross-file-disjoint';

export interface SemanticConflictDecision {
  /** True ⇒ the pair must NOT run in parallel (defer exactly as t25 does). */
  conflict: boolean;
  /** Machine-readable why, for radio/workbench telemetry. */
  reasonCode: SemanticReasonCode;
  /**
   * First file named by BOTH sides, when one exists (telemetry anchor for the
   * executor's rescue path). Undefined for purely cross-file claim pairs.
   */
  contestedFile?: string;
}

/**
 * Parse one ownership claim: `"<file>#<SymbolName>"` or
 * `"<file>#<Symbol.method>"` (exactly one `#`, at most one `.` in the symbol,
 * no whitespace anywhere). Returns null on anything else — a malformed claim
 * is a MISSING claim, and callers treat missing as conflict.
 */
export function parseOwnedSymbol(spec: string): OwnedSymbol | null {
  const s = spec.trim();
  const hash = s.indexOf('#');
  if (hash <= 0 || hash === s.length - 1) return null; // no/edge `#`, empty halves
  const file = s.slice(0, hash);
  const symbol = s.slice(hash + 1);
  if (file.includes('#') || symbol.includes('#')) return null;
  if (/\s/.test(file) || /\s/.test(symbol)) return null;
  const segments = symbol.split('.');
  if (segments.length > 2 || segments.some((seg) => seg.length === 0)) return null;
  return { file, symbol };
}

/** Parse a whole claim list; null when ANY spec is malformed (fail-closed). */
function parseOwnedSymbols(specs: readonly string[]): OwnedSymbol[] | null {
  const out: OwnedSymbol[] = [];
  for (const spec of specs) {
    const parsed = parseOwnedSymbol(spec);
    if (!parsed) return null;
    out.push(parsed);
  }
  return out;
}

/** Same file after path-separator + case folding (conservative on both). */
function sameFile(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

/** Symbol identity is dot-aware and case-folded: `Auth.login` ≠ `Auth.refresh`. */
function sameSymbol(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Are two parsed claim sets disjoint? `null` when either side declares
 * nothing (the caller's honest default is then CONFLICT); `false` when any
 * file+symbol pair intersects; `true` when every pair is disjoint — including
 * different symbols in the same file, and purely cross-file claims.
 */
export function symbolsDisjoint(
  a: readonly OwnedSymbol[],
  b: readonly OwnedSymbol[],
): boolean | null {
  if (a.length === 0 || b.length === 0) return null;
  for (const x of a) {
    for (const y of b) {
      if (sameFile(x.file, y.file) && sameSymbol(x.symbol, y.symbol)) return false;
    }
  }
  return true;
}

/** Files named by BOTH sides — the claims the AST (if any) must verify. */
function contestedFiles(a: readonly OwnedSymbol[], b: readonly OwnedSymbol[]): string[] {
  const files: string[] = [];
  for (const x of a) {
    if (!files.some((f) => sameFile(f, x.file)) && b.some((y) => sameFile(x.file, y.file))) {
      files.push(x.file);
    }
  }
  return files;
}

/**
 * A claim `Sym` / `Sym.method` is confirmed when the extracted names contain
 * it verbatim, its container, or a dotted form ending in it (the extractor
 * may report methods as `Container.method` or bare `method`).
 */
function symbolDeclaredIn(names: readonly string[], spec: OwnedSymbol): boolean {
  const segments = spec.symbol.split('.');
  const container = segments[0];
  const method = segments.length > 1 ? segments[1] : undefined;
  return names.some((n) => {
    const folded = n.toLowerCase();
    return (
      folded === spec.symbol.toLowerCase() ||
      folded === container.toLowerCase() ||
      (method !== undefined && folded === method.toLowerCase()) ||
      folded.endsWith(`.${spec.symbol.toLowerCase()}`)
    );
  });
}

/**
 * The P2.B admission question for one pair of writers: may they run in
 * parallel because their DECLARED symbol claims are disjoint?
 *
 * Order of answers (each earlier one short-circuits):
 *  1. either side declares nothing → conflict `undeclared-symbols` (today's
 *     t25 deferral applies — this module never widens an undeclared pair);
 *  2. any spec malformed → conflict `malformed-spec` (fail-closed);
 *  3. spec intersection → conflict `symbol-intersects`;
 *  4. purely cross-file claims → no conflict `cross-file-disjoint` (no AST
 *     needed — the claims never name the same file);
 *  5. same-file claims verified against the injected AST when available:
 *     extraction failure → conflict `ast-extract-failed`, a declared symbol
 *     missing from the file → conflict `symbol-not-found` (a claim we cannot
 *     confirm is a claim we cannot trust), else no conflict `symbol-disjoint`;
 *  6. same-file claims WITHOUT an extractor / unsupported file → spec-only
 *     comparison, no conflict `symbol-disjoint-spec-only` (v1 honesty: the
 *     declaration is trusted, the file contents are not consulted).
 */
export async function semanticConflictDecision(
  nodeA: SymbolOwnershipNode,
  nodeB: SymbolOwnershipNode,
  ctx: SemanticConflictCtx = {},
): Promise<SemanticConflictDecision> {
  const claimsA = parseOwnedSymbols(nodeA.ownedSymbols ?? []);
  const claimsB = parseOwnedSymbols(nodeB.ownedSymbols ?? []);
  // parseOwnedSymbols returns null only when some spec is malformed; an empty
  // claim list (node declares nothing) stays an empty array.
  if (!claimsA || !claimsB) return { conflict: true, reasonCode: 'malformed-spec' };
  if (claimsA.length === 0 || claimsB.length === 0) {
    return { conflict: true, reasonCode: 'undeclared-symbols' };
  }
  const disjoint = symbolsDisjoint(claimsA, claimsB);
  if (disjoint === false) return { conflict: true, reasonCode: 'symbol-intersects' };

  const contested = contestedFiles(claimsA, claimsB);
  if (contested.length === 0) return { conflict: false, reasonCode: 'cross-file-disjoint' };
  const anchor = { contestedFile: contested[0] };
  if (!ctx.extractSymbols || !ctx.astSupported || !contested.every((f) => ctx.astSupported!(f))) {
    return { conflict: false, reasonCode: 'symbol-disjoint-spec-only', ...anchor };
  }

  for (const file of contested) {
    let names: readonly string[] | null;
    try {
      names = await ctx.extractSymbols(file);
    } catch {
      return { conflict: true, reasonCode: 'ast-extract-failed' };
    }
    if (names === null) return { conflict: true, reasonCode: 'ast-extract-failed' };
    const inA = claimsA.filter((c) => sameFile(c.file, file));
    const inB = claimsB.filter((c) => sameFile(c.file, file));
    if (
      !inA.every((c) => symbolDeclaredIn(names!, c)) ||
      !inB.every((c) => symbolDeclaredIn(names!, c))
    ) {
      return { conflict: true, reasonCode: 'symbol-not-found' };
    }
  }
  return { conflict: false, reasonCode: 'symbol-disjoint', ...anchor };
}
