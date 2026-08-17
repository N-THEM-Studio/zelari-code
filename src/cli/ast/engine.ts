/**
 * ast/engine — structural (AST) analysis for TS/JS via the TypeScript
 * compiler API.
 *
 * Where LSP gives cross-file navigation, this gives precise *structural*
 * targeting inside a file with zero server setup: an exact outline of every
 * declaration (with line ranges + exported flag) and the ability to pull a
 * named declaration's exact source span. The agent uses that span to make
 * reliable, node-accurate edits through the normal (sandboxed, diagnostics-
 * wrapped) edit path — instead of fragile whole-file string matching.
 *
 * `typescript` is loaded lazily via dynamic import and kept OUT of the CLI
 * bundle (it's ~7MB, marked external in bundle-cli.mjs).
 *
 * Loud degradation (v0.10.0 "loud tool errors"): `parseFileSymbolsDiag` is
 * the primary entry point and returns a DISCRIMINATED result, so an empty
 * outcome can never be confused with an unavailable backend. The legacy
 * `parseFileSymbols`/`astOutline`/`findSymbol` helpers remain as quiet
 * compatibility wrappers (empty/null on any non-ok status).
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export type AstSymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable';

export interface AstSymbol {
  name: string;
  kind: AstSymbolKind;
  /** 1-based first line of the declaration. */
  line: number;
  /** 1-based last line of the declaration. */
  endLine: number;
  /** True when the declaration is exported. */
  exported: boolean;
}

export interface AstSymbolWithText extends AstSymbol {
  /** The exact source text of the declaration node. */
  text: string;
}

/**
 * Machine-readable fallback hint attached to non-ok parse results.
 * It is a HINT for the model — never auto-executed by the engine.
 */
export type AstRecommendedFallback = 'grep_content' | 'read_file';

/**
 * Machine-readable diagnostic fields carried by EVERY non-ok variant of
 * {@link ParseFileSymbolsResult} (rev.2: the info must not live only in the
 * human-facing `note` string of the tool result).
 */
interface AstDiagBase {
  /** Absolute path the engine actually looked at (when resolution happened). */
  resolvedPath?: string;
  /** True when a retry / fallback could still produce a real answer. */
  recoverable: boolean;
  /** Suggested next tool to try. Hint only — never auto-executed. */
  recommendedFallback?: AstRecommendedFallback;
}

/**
 * Discriminated parse outcome. EMPTY ≠ DEGRADED: a non-ok status always says
 * WHY the symbol list is missing.
 */
export type ParseFileSymbolsResult =
  | { status: 'ok'; symbols: AstSymbolWithText[] }
  | ({ status: 'unsupported-extension'; extension: string } & AstDiagBase)
  | ({ status: 'typescript-unavailable' } & AstDiagBase)
  | ({ status: 'file-not-found'; resolvedPath: string } & AstDiagBase)
  | ({ status: 'read-error'; resolvedPath: string; message: string } & AstDiagBase)
  | ({ status: 'parse-error'; resolvedPath: string; message: string } & AstDiagBase);

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/** True if this file's extension is one the TS compiler API can parse. */
export function isAstSupported(file: string): boolean {
  return TS_EXTENSIONS.has(path.extname(file).toLowerCase());
}

// Lazy, memoized TypeScript module load. Returns null if unavailable.
let tsPromise: Promise<typeof import('typescript') | null> | undefined;
function loadTs(): Promise<typeof import('typescript') | null> {
  if (!tsPromise) {
    tsPromise = import('typescript')
      .then((m) => (m.default ?? m) as typeof import('typescript'))
      .catch(() => null);
  }
  return tsPromise;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse a TS/JS file into its top-level + nested declarations (with exact
 * source text), reporting WHY on every failure path.
 *
 * Relative paths resolve against `cwd ?? process.cwd()` (same rule as
 * grep_content, see core builtin search.ts). Read errors distinguish ENOENT
 * (`file-not-found`, reports the resolved absolute path) from anything else
 * (`read-error`, propagates the message); a failing `createSourceFile`
 * surfaces as `parse-error`.
 */
export async function parseFileSymbolsDiag(
  file: string,
  cwd?: string,
): Promise<ParseFileSymbolsResult> {
  const resolvedPath = path.isAbsolute(file)
    ? file
    : path.join(cwd ?? process.cwd(), file);

  const extension = path.extname(resolvedPath).toLowerCase();
  if (!TS_EXTENSIONS.has(extension)) {
    return {
      status: 'unsupported-extension',
      extension: extension || '(none)',
      resolvedPath,
      recoverable: false,
      recommendedFallback: 'read_file',
    };
  }

  const ts = await loadTs();
  if (!ts) {
    return {
      status: 'typescript-unavailable',
      resolvedPath,
      recoverable: true,
      recommendedFallback: 'read_file',
    };
  }

  let text: string;
  try {
    text = await readFile(resolvedPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return {
        status: 'file-not-found',
        resolvedPath,
        recoverable: false,
        recommendedFallback: 'grep_content',
      };
    }
    return {
      status: 'read-error',
      resolvedPath,
      message: errMessage(err),
      recoverable: true,
      recommendedFallback: 'read_file',
    };
  }

  let source: import('typescript').SourceFile;
  try {
    source = ts.createSourceFile(path.basename(resolvedPath), text, ts.ScriptTarget.Latest, true);
  } catch (err) {
    return {
      status: 'parse-error',
      resolvedPath,
      message: errMessage(err),
      recoverable: false,
      recommendedFallback: 'read_file',
    };
  }

  const out: AstSymbolWithText[] = [];
  const lineOf = (pos: number): number => source.getLineAndCharacterOfPosition(pos).line + 1;

  const hasExport = (node: import('typescript').Node): boolean => {
    const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  };

  const record = (
    name: string,
    kind: AstSymbolKind,
    node: import('typescript').Node,
    exported: boolean,
  ) => {
    out.push({
      name,
      kind,
      line: lineOf(node.getStart(source)),
      endLine: lineOf(node.getEnd()),
      exported,
      text: node.getText(source),
    });
  };

  const visit = (node: import('typescript').Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      record(node.name.text, 'function', node, hasExport(node));
    } else if (ts.isClassDeclaration(node) && node.name) {
      record(node.name.text, 'class', node, hasExport(node));
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          record(member.name.text, 'method', member, false);
        }
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      record(node.name.text, 'interface', node, hasExport(node));
    } else if (ts.isTypeAliasDeclaration(node)) {
      record(node.name.text, 'type', node, hasExport(node));
    } else if (ts.isEnumDeclaration(node)) {
      record(node.name.text, 'enum', node, hasExport(node));
    } else if (ts.isVariableStatement(node)) {
      const exported = hasExport(node);
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const init = decl.initializer;
        const isFn = !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
        // Attribute the whole statement's span so the exact text round-trips.
        record(decl.name.text, isFn ? 'function' : 'variable', node, exported);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return { status: 'ok', symbols: out };
}

/**
 * Compatibility wrapper over {@link parseFileSymbolsDiag}: same quiet
 * contract as before (empty array on any non-ok status). New callers should
 * prefer the diag version.
 */
export async function parseFileSymbols(file: string): Promise<AstSymbolWithText[]> {
  const r = await parseFileSymbolsDiag(file);
  return r.status === 'ok' ? r.symbols : [];
}

/** Outline: all declarations in a file (no source text). Quiet on failure. */
export async function astOutline(file: string): Promise<AstSymbol[]> {
  const r = await parseFileSymbolsDiag(file);
  if (r.status !== 'ok') return [];
  return r.symbols.map(({ text: _text, ...rest }) => rest);
}

/**
 * Find a named declaration and return its exact source text + range. When
 * several declarations share a name (overloads, a method and a function),
 * returns the first by source order. Quiet (null) on any non-ok status.
 */
export async function findSymbol(file: string, name: string): Promise<AstSymbolWithText | null> {
  const r = await parseFileSymbolsDiag(file);
  if (r.status !== 'ok') return null;
  return r.symbols.find((s) => s.name === name) ?? null;
}
