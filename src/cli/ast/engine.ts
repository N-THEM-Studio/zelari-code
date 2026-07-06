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
 * bundle (it's ~7MB, marked external in bundle-cli.mjs). Everything here is
 * best-effort: if `typescript` can't be loaded, the file can't be read, or it
 * isn't a TS/JS file, the functions return empty/null rather than throwing.
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

/**
 * Parse a TS/JS file into its top-level + nested declarations (with exact
 * source text). Returns [] for unsupported files, read errors, or when the
 * TypeScript compiler API is unavailable.
 */
export async function parseFileSymbols(file: string): Promise<AstSymbolWithText[]> {
  if (!isAstSupported(file)) return [];
  const ts = await loadTs();
  if (!ts) return [];
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }

  let source: import('typescript').SourceFile;
  try {
    source = ts.createSourceFile(path.basename(file), text, ts.ScriptTarget.Latest, true);
  } catch {
    return [];
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
  return out;
}

/** Outline: all declarations in a file (no source text). */
export async function astOutline(file: string): Promise<AstSymbol[]> {
  const symbols = await parseFileSymbols(file);
  return symbols.map(({ text: _text, ...rest }) => rest);
}

/**
 * Find a named declaration and return its exact source text + range. When
 * several declarations share a name (overloads, a method and a function),
 * returns the first by source order.
 */
export async function findSymbol(file: string, name: string): Promise<AstSymbolWithText | null> {
  const symbols = await parseFileSymbols(file);
  return symbols.find((s) => s.name === name) ?? null;
}
