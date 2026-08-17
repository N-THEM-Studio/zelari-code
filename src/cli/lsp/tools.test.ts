import { describe, it, expect } from 'vitest';
import { createLspTools } from './tools.js';
import type { LspProvider, SymbolInfo, RenameResult } from './manager.js';
import type { Location } from './protocol.js';

/**
 * WS4 — LSP read-only in plan + EMPTY ≠ DEGRADED (piano §8, t4).
 *
 * The tools must (a) stay pure read-only surface, and (b) when the provider
 * reports `serverStatusFor → 'unavailable'`, stamp an explicit `degraded`
 * field on the result instead of presenting an empty array as evidence.
 */

function loc(file: string, line: number, col: number): Location {
  return {
    uri: `file:///${file.replace(/\\/g, '/')}`,
    range: { start: { line: line - 1, character: col - 1 }, end: { line: line - 1, character: col } },
  };
}

function makeProvider(overrides?: Partial<LspProvider> & { status?: 'available' | 'unavailable' }): LspProvider {
  const status = overrides?.status ?? 'available';
  const base: LspProvider = {
    definition: async () => [loc('src/a.ts', 10, 3)],
    references: async () => [loc('src/a.ts', 10, 3), loc('src/b.ts', 42, 17)],
    hover: async () => '(hover) const x: number',
    documentSymbols: async () =>
      [{ kind: 'function', name: 'foo', line: 1 } satisfies SymbolInfo],
    rename: async () =>
      ({ totalEdits: 2, files: [{ file: 'src/a.ts', count: 2 }] } satisfies RenameResult),
    dispose: () => {},
  };
  const merged: LspProvider = { ...base, ...overrides };
  // serverStatusFor is not part of older fakes; attach explicitly.
  (merged as LspProvider & { serverStatusFor?: (f: string) => 'available' | 'unavailable' }).serverStatusFor =
    () => status;
  return merged;
}

function tool(names: ReturnType<typeof createLspTools>, name: string) {
  const t = names.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

describe('createLspTools — WS4', () => {
  it('all five tools are read-only (permissions: ["read"])', () => {
    for (const t of createLspTools(makeProvider())) {
      expect(t.permissions).toEqual(['read']);
    }
  });

  it('healthy provider: results carry no degraded field', async () => {
    const tools = createLspTools(makeProvider(), '/proj');
    const def = await tool(tools, 'go_to_definition').execute({ path: 'src/a.ts', line: 10, column: 3 }, undefined as never);
    expect(def).toMatchObject({ ok: true });
    if (def.ok) {
      expect(def.value).toHaveProperty('count', 1);
      expect(def.value).not.toHaveProperty('degraded');
      expect(JSON.stringify(def.value)).toContain('src/a.ts:10:3');
    }
  });

  it('unavailable server: go_to_definition stamps LSP_PROVIDER_DEGRADED (EMPTY ≠ DEGRADED)', async () => {
    const tools = createLspTools(makeProvider({ status: 'unavailable', definition: async () => [] }), '/proj');
    const res = await tool(tools, 'go_to_definition').execute({ path: 'src/a.ts', line: 10, column: 3 }, undefined as never);
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.value).toHaveProperty('count', 0);
      const degraded = (res.value as { degraded?: string }).degraded;
      expect(degraded).toContain('LSP_PROVIDER_DEGRADED');
      expect(degraded).toContain('NOT evidence');
    }
  });

  it('unavailable server: find_references + document_symbols stamp degraded on empty results', async () => {
    const tools = createLspTools(
      makeProvider({ status: 'unavailable', references: async () => [], documentSymbols: async () => [] }),
      '/proj',
    );
    const refs = await tool(tools, 'find_references').execute({ path: 'src/a.ts', line: 10, column: 3 }, undefined as never);
    const syms = await tool(tools, 'document_symbols').execute({ path: 'src/a.ts' }, undefined as never);
    expect(refs.ok && (refs.value as { degraded?: string }).degraded).toContain('LSP_PROVIDER_DEGRADED');
    expect(syms.ok && (syms.value as { degraded?: string }).degraded).toContain('LSP_PROVIDER_DEGRADED');
  });

  it('unavailable server: hover null becomes degraded note, not "(no hover information)"', async () => {
    const tools = createLspTools(makeProvider({ status: 'unavailable', hover: async () => null }), '/proj');
    const res = await tool(tools, 'hover_type').execute({ path: 'src/a.ts', line: 10, column: 3 }, undefined as never);
    expect(res.ok && (res.value as { hover: string }).hover).toContain('LSP_PROVIDER_DEGRADED');
  });

  it('unavailable server: rename null becomes degraded note; rename preview stays read-only', async () => {
    const tools = createLspTools(makeProvider({ status: 'unavailable', rename: async () => null }), '/proj');
    const res = await tool(tools, 'rename_symbol').execute(
      { path: 'src/a.ts', line: 10, column: 3, newName: 'bar' },
      undefined as never,
    );
    expect(res.ok && (res.value as { preview: string }).preview).toContain('LSP_PROVIDER_DEGRADED');
  });

  it('provider without serverStatusFor (legacy fake): never degrades', async () => {
    const provider = makeProvider({ definition: async () => [] });
    delete (provider as LspProvider & { serverStatusFor?: unknown }).serverStatusFor;
    const tools = createLspTools(provider, '/proj');
    const res = await tool(tools, 'go_to_definition').execute({ path: 'src/a.ts', line: 10, column: 3 }, undefined as never);
    expect(res.ok && JSON.stringify(res.value)).not.toContain('DEGRADED');
  });
});
