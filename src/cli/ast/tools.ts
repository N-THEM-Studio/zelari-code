/**
 * ast/tools — structural (AST) navigation tools for TS/JS.
 *
 * `ast_outline` gives a precise declaration outline of a file (functions,
 * classes, methods, interfaces, types, enums, variables) with line ranges and
 * exported flags — offline, no language server needed. `find_symbol` returns a
 * named declaration's EXACT source span + text, so the agent can target it and
 * edit reliably through the normal edit tools instead of fuzzy string matching.
 *
 * Read-only: neither tool writes. Both are best-effort (empty result when
 * TypeScript is unavailable or the file isn't TS/JS).
 */

import { z } from 'zod';
import { typedOk, type ToolDefinition } from '@zelari/core/harness/tools/toolTypes';
import { astOutline, findSymbol } from './engine.js';

/** Cap the returned declaration text so a huge class can't flood the context. */
const MAX_TEXT_CHARS = 4000;

export function createAstTools(): ToolDefinition[] {
  const outline: ToolDefinition = {
    name: 'ast_outline',
    description:
      'Structural outline of a TS/JS file: every declaration (function, class, ' +
      'method, interface, type, enum, variable) with its line range and whether ' +
      "it's exported. Faster and more precise than reading the whole file to find " +
      'where things are. TS/JS only.',
    permissions: ['read'],
    inputSchema: z.object({
      path: z.string().min(1).describe('Path to the TS/JS file to outline.'),
    }),
    execute: async (args) => {
      const { path: file } = args as { path: string };
      const symbols = await astOutline(file);
      if (symbols.length === 0) {
        return typedOk({ symbols: [], note: 'no declarations found (or not a TS/JS file / TypeScript unavailable)' });
      }
      return typedOk({
        count: symbols.length,
        symbols: symbols.map(
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
      'surrounding text. TS/JS only.',
    permissions: ['read'],
    inputSchema: z.object({
      path: z.string().min(1).describe('Path to the TS/JS file.'),
      name: z.string().min(1).describe('The declaration name to find (function/class/method/etc).'),
    }),
    execute: async (args) => {
      const { path: file, name } = args as { path: string; name: string };
      const sym = await findSymbol(file, name);
      if (!sym) {
        return typedOk({ found: false, note: `no declaration named "${name}" found in ${file}` });
      }
      const truncated = sym.text.length > MAX_TEXT_CHARS;
      return typedOk({
        found: true,
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
