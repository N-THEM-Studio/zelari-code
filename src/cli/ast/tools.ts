/**
 * ast/tools — structural (AST) navigation tools for TS/JS.
 *
 * `ast_outline` gives a precise declaration outline of a file (functions,
 * classes, methods, interfaces, types, enums, variables) with line ranges and
 * exported flags — offline, no language server needed. `find_symbol` returns a
 * named declaration's EXACT source span + text, so the agent can target it and
 * edit reliably through the normal edit tools instead of fuzzy string matching.
 *
 * Read-only: neither tool writes.
 *
 * Loud degradation (v0.10.0 "loud tool errors"): every empty outcome carries a
 * discriminated `status` (file-not-found / typescript-unavailable /
 * unsupported-extension / read-error / parse-error) plus machine-readable
 * `resolvedPath` / `recoverable` / `recommendedFallback` fields. `found: false`
 * is only ever reported when the file was read AND parsed successfully.
 */

import { z } from 'zod';
import { typedOk, type ToolDefinition } from '@zelari/core/harness/tools/toolTypes';
import {
  parseFileSymbolsDiag,
  type AstRecommendedFallback,
  type ParseFileSymbolsResult,
} from './engine.js';

/** Cap the returned declaration text so a huge class can't flood the context. */
const MAX_TEXT_CHARS = 4000;

/**
 * Build the loud, machine-readable payload shared by every non-ok status.
 * `recommendedFallback` is a hint for the model — never auto-executed.
 */
function degradedPayload(
  r: Exclude<ParseFileSymbolsResult, { status: 'ok' }>,
): {
  status: ParseFileSymbolsResult['status'];
  resolvedPath?: string;
  recoverable: boolean;
  recommendedFallback?: AstRecommendedFallback;
} {
  return {
    status: r.status,
    resolvedPath: r.resolvedPath,
    recoverable: r.recoverable,
    recommendedFallback: r.recommendedFallback,
  };
}

/** Human-facing note for each non-ok status — one cause, no "maybe" lists. */
function degradedNote(r: Exclude<ParseFileSymbolsResult, { status: 'ok' }>): string {
  switch (r.status) {
    case 'file-not-found':
      return `file not found — looked at ${r.resolvedPath} (relative paths resolve against the workspace root)`;
    case 'typescript-unavailable':
      return 'TypeScript compiler API unavailable — the "typescript" package could not be loaded. ' +
        'AST tools need it; disable them with ZELARI_AST=0 or fall back to read_file/grep_content.';
    case 'unsupported-extension':
      return `unsupported file extension "${r.extension}" — ast_outline/find_symbol only parse TS/JS files (.ts/.tsx/.js/.jsx/.mjs/.cjs)`;
    case 'read-error':
      return `could not read ${r.resolvedPath}: ${r.message}`;
    case 'parse-error':
      return `TypeScript failed to parse ${r.resolvedPath}: ${r.message}`;
  }
}

/**
 * Create the AST tools bound to a workspace `root` (S2.0: the root is
 * propagated by the registry, which already has it in scope). At call time
 * relative paths resolve against `ctx.cwd` first (aligned with grep_content),
 * falling back to `root`.
 */
export function createAstTools(root: string): ToolDefinition[] {
  const outline: ToolDefinition = {
    name: 'ast_outline',
    description:
      'Structural outline of a TS/JS file: every declaration (function, class, ' +
      'method, interface, type, enum, variable) with its line range and whether ' +
      "it's exported. Faster and more precise than reading the whole file to find " +
      'where things are. Relative paths resolve against the working directory. ' +
      'TS/JS only.',
    permissions: ['read'],
    inputSchema: z.object({
      path: z.string().min(1).describe('Path to the TS/JS file to outline.'),
    }),
    execute: async (args, ctx) => {
      const { path: file } = args as { path: string };
      const r = await parseFileSymbolsDiag(file, ctx?.cwd ?? root);
      if (r.status !== 'ok') {
        return typedOk({ symbols: [], note: degradedNote(r), ...degradedPayload(r) });
      }
      if (r.symbols.length === 0) {
        // Genuinely empty file (or only ambient/implicit declarations):
        // the file WAS read and parsed, so this is a true empty — say so.
        return typedOk({
          status: 'ok',
          count: 0,
          symbols: [],
          note: 'file parsed successfully but contains no declarations',
        });
      }
      return typedOk({
        status: 'ok',
        count: r.symbols.length,
        symbols: r.symbols.map(
          (s) =>
            `${s.exported ? 'export ' : ''}${s.kind} ${s.name} (lines ${s.line}-${s.endLine})`,
        ),
      });
    },
  };

  const findSymbolTool: ToolDefinition = {
    name: 'find_symbol',
    description:
      "Locate a named declaration in a TS/JS file and return its EXACT source " +
      'text and line range. Use this to grab a function/class/method verbatim so ' +
      'you can edit_file it reliably (node-accurate) instead of guessing the ' +
      'surrounding text. Relative paths resolve against the working directory. ' +
      'TS/JS only.',
    permissions: ['read'],
    inputSchema: z.object({
      path: z.string().min(1).describe('Path to the TS/JS file.'),
      name: z.string().min(1).describe('The declaration name to find (function/class/method/etc).'),
    }),
    execute: async (args, ctx) => {
      const { path: file, name } = args as { path: string; name: string };
      const r = await parseFileSymbolsDiag(file, ctx?.cwd ?? root);
      if (r.status !== 'ok') {
        return typedOk({ found: false, note: degradedNote(r), ...degradedPayload(r) });
      }
      const sym = r.symbols.find((s) => s.name === name);
      if (!sym) {
        // File was read and parsed: a REAL not-found, safe to state.
        return typedOk({
          found: false,
          status: 'ok',
          note: `no declaration named "${name}" found in ${r.symbols.length > 0 ? `${file} (declarations present: ${[...new Set(r.symbols.map((s) => s.name))].slice(0, 12).join(', ')})` : file}`,
        });
      }
      const truncated = sym.text.length > MAX_TEXT_CHARS;
      return typedOk({
        found: true,
        status: 'ok',
        kind: sym.kind,
        exported: sym.exported,
        line: sym.line,
        endLine: sym.endLine,
        text: truncated ? `${sym.text.slice(0, MAX_TEXT_CHARS)}\n… (truncated, ${sym.text.length} chars total)` : sym.text,
      });
    },
  };

  return [outline, findSymbolTool];
}
