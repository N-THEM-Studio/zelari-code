/**
 * lsp/tools — agent-facing LSP navigation tools.
 *
 * These give the agent IDE-grade code intelligence: jump to a definition,
 * find every reference, read the real type/docs under a symbol, list a file's
 * symbols, and preview the blast radius of a rename. They depend only on the
 * `LspProvider` interface, so they're unit-testable with a fake provider (no
 * language server required).
 *
 * Positions are exposed to the model as 1-based `line`/`column` (what editors
 * show) and converted to LSP's 0-based coordinates internally.
 *
 * WS4 EMPTY ≠ DEGRADED: when the provider reports no language server for the
 * file (`serverStatusFor` → 'unavailable'), every tool adds an explicit
 * `degraded` field to its result. An empty array stays an empty array, but it
 * is never silently presented as evidence about the symbol.
 */

import { z } from 'zod';
import { typedOk, type ToolDefinition } from '@zelari/core/harness/tools/toolTypes';
import { uriToPath, type Location } from './protocol.js';
import type { LspProvider } from './manager.js';
import { relativePosix } from '../utils/paths.js';

function fmtLocation(loc: Location, relativeTo?: string): string {
  const file = uriToPath(loc.uri);
  const rel = relativeTo ? relativePosix(relativeTo, file) : file;
  // LSP ranges are 0-based; present 1-based to match editors.
  const line = (loc.range?.start?.line ?? 0) + 1;
  const col = (loc.range?.start?.character ?? 0) + 1;
  return `${rel}:${line}:${col}`;
}

/**
 * Degraded-provider note (WS4). Call AFTER the provider method, so the
 * lazily-spawned manager has had a chance to record the failure.
 * Providers without `serverStatusFor` (older fakes/tests) never degrade.
 */
function degradedNote(provider: LspProvider, file: string): string | undefined {
  if (provider.serverStatusFor?.(file) !== 'unavailable') return undefined;
  return (
    'LSP_PROVIDER_DEGRADED: no language server is available for this file ' +
    '(server not installed or failed to start) — an empty result here is NOT ' +
    'evidence about the symbol; fall back to ast_outline/find_symbol, ' +
    'grep_content or read_file.'
  );
}

const PosArgs = z.object({
  path: z.string().min(1).describe('File path (relative to the project root or absolute).'),
  line: z.number().int().positive().describe('1-based line number of the symbol.'),
  column: z.number().int().positive().describe('1-based column of the symbol.'),
});

/** Build the LSP tool set from a provider. `root` is used to relativize paths. */
export function createLspTools(provider: LspProvider, root: string = process.cwd()): ToolDefinition[] {
  const goToDefinition: ToolDefinition = {
    name: 'go_to_definition',
    description:
      'Jump to where the symbol at a position is defined (via the language server). ' +
      'Returns the defining file:line:col — use it instead of guessing with grep.',
    permissions: ['read'],
    inputSchema: PosArgs,
    execute: async (args) => {
      const a = args as z.infer<typeof PosArgs>;
      const locs = await provider.definition(a.path, a.line - 1, a.column - 1);
      const degraded = degradedNote(provider, a.path);
      return typedOk({
        definitions: locs.map((l) => fmtLocation(l, root)),
        count: locs.length,
        ...(degraded ? { degraded } : {}),
      });
    },
  };

  const findReferences: ToolDefinition = {
    name: 'find_references',
    description:
      'Find every reference to the symbol at a position across the workspace ' +
      '(via the language server). Returns a list of file:line:col — reliable ' +
      'where a text grep would miss shadowed names or match strings/comments.',
    permissions: ['read'],
    inputSchema: PosArgs,
    execute: async (args) => {
      const a = args as z.infer<typeof PosArgs>;
      const locs = await provider.references(a.path, a.line - 1, a.column - 1);
      const degraded = degradedNote(provider, a.path);
      return typedOk({
        references: locs.map((l) => fmtLocation(l, root)),
        count: locs.length,
        ...(degraded ? { degraded } : {}),
      });
    },
  };

  const hoverType: ToolDefinition = {
    name: 'hover_type',
    description:
      'Get the resolved type signature and documentation for the symbol at a ' +
      'position (via the language server) — the real type the compiler sees.',
    permissions: ['read'],
    inputSchema: PosArgs,
    execute: async (args) => {
      const a = args as z.infer<typeof PosArgs>;
      const text = await provider.hover(a.path, a.line - 1, a.column - 1);
      const degraded = degradedNote(provider, a.path);
      return typedOk({
        // Degraded + no text → the note replaces the neutral message:
        // "(no hover information)" would be a fake-empty under a dead server.
        hover: text ?? degraded ?? '(no hover information)',
        ...(degraded ? { degraded } : {}),
      });
    },
  };

  const documentSymbols: ToolDefinition = {
    name: 'document_symbols',
    description:
      'List the symbols (functions, classes, methods, variables) declared in a ' +
      'file with their line numbers — a fast structural outline via the language server.',
    permissions: ['read'],
    inputSchema: z.object({
      path: z.string().min(1).describe('File path to outline.'),
    }),
    execute: async (args) => {
      const a = args as { path: string };
      const symbols = await provider.documentSymbols(a.path);
      const degraded = degradedNote(provider, a.path);
      return typedOk({
        symbols: symbols.map((s) => `${s.kind} ${s.name} (line ${s.line})`),
        count: symbols.length,
        ...(degraded ? { degraded } : {}),
      });
    },
  };

  const renameSymbol: ToolDefinition = {
    name: 'rename_symbol',
    description:
      'PREVIEW a safe, workspace-wide rename of the symbol at a position (via the ' +
      'language server): returns which files change and how many edits each gets, ' +
      'so you know the blast radius before touching anything. It does NOT write ' +
      'files — apply the change yourself with edit once the scope looks right.',
    permissions: ['read'],
    inputSchema: PosArgs.extend({
      newName: z.string().min(1).describe('The new symbol name.'),
    }),
    execute: async (args) => {
      const a = args as z.infer<typeof PosArgs> & { newName: string };
      const result = await provider.rename(a.path, a.line - 1, a.column - 1, a.newName);
      const degraded = degradedNote(provider, a.path);
      if (!result) {
        return typedOk({
          preview:
            degraded ??
            'no rename available at this position (symbol not found or not renameable)',
        });
      }
      return typedOk({
        totalEdits: result.totalEdits,
        files: result.files.map((f) => `${relativePosix(root, f.file)} (${f.count} edit${f.count === 1 ? '' : 's'})`),
        ...(degraded ? { degraded } : {}),
      });
    },
  };

  return [goToDefinition, findReferences, hoverType, documentSymbols, renameSymbol];
}
