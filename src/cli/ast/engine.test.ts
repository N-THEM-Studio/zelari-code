/**
 * S2.1/S2.3 — unit tests for the loud, discriminated parse result of
 * ast/engine (plan: .zelari/docs/piano-loud-tool-errors-ast-diag-readonly-shell.md §2).
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi, describe, it, expect } from 'vitest';
import {
  parseFileSymbolsDiag,
  parseFileSymbols,
  astOutline,
  findSymbol,
} from './engine.js';

const SAMPLE = [
  'export interface Shape { kind: string }',
  'export class Circle implements Shape {',
  '  kind = "circle";',
  '  area(): number { return 1; }',
  '}',
  'export const area = (r: number): number => r * r;',
  'const hidden = 1;',
  '',
].join('\n');

describe('parseFileSymbolsDiag', () => {
  it('resolves relative paths against the injected cwd and parses symbols', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'zelari-ast-'));
    await writeFile(path.join(dir, 'sample.ts'), SAMPLE, 'utf8');

    const r = await parseFileSymbolsDiag('sample.ts', dir);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const names = r.symbols.map((s) => s.name);
    expect(names).toContain('Shape');
    expect(names).toContain('Circle');
    expect(names).toContain('area'); // arrow function → kind 'function'
    expect(names).toContain('hidden');
    const circle = r.symbols.find((s) => s.name === 'Circle')!;
    expect(circle.exported).toBe(true);
    expect(circle.text).toContain('area(): number');
  });

  it('reports file-not-found with the ABSOLUTE resolved path', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'zelari-ast-'));
    const r = await parseFileSymbolsDiag('missing.ts', dir);
    expect(r.status).toBe('file-not-found');
    if (r.status !== 'file-not-found') return;
    expect(r.resolvedPath).toBe(path.join(dir, 'missing.ts'));
    expect(path.isAbsolute(r.resolvedPath)).toBe(true);
    expect(r.recoverable).toBe(false);
    expect(r.recommendedFallback).toBe('grep_content');
  });

  it('reports unsupported-extension with the extension it saw', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'zelari-ast-'));
    await writeFile(path.join(dir, 'script.py'), 'def f(): pass\n', 'utf8');
    const r = await parseFileSymbolsDiag('script.py', dir);
    expect(r.status).toBe('unsupported-extension');
    if (r.status !== 'unsupported-extension') return;
    expect(r.extension).toBe('.py');
    expect(r.resolvedPath).toBe(path.join(dir, 'script.py'));
  });

  it('reports typescript-unavailable when the compiler API cannot load', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'zelari-ast-'));
    await writeFile(path.join(dir, 'sample.ts'), SAMPLE, 'utf8');
    // Fresh module graph where the dynamic `import('typescript')` rejects.
    vi.resetModules();
    vi.doMock('typescript', () => {
      throw new Error('simulated: typescript not installed');
    });
    try {
      const fresh = await import('./engine.js');
      const r = await fresh.parseFileSymbolsDiag('sample.ts', dir);
      expect(r.status).toBe('typescript-unavailable');
      if (r.status !== 'typescript-unavailable') return;
      expect(r.recoverable).toBe(true);
      expect(r.recommendedFallback).toBe('read_file');
    } finally {
      vi.doUnmock('typescript');
    }
  });
});

describe('quiet compatibility wrappers', () => {
  it('parseFileSymbols: [] on non-ok, symbols on ok', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'zelari-ast-'));
    const file = path.join(dir, 'sample.ts');
    await writeFile(file, SAMPLE, 'utf8');
    // No cwd → resolves against process.cwd(); absolute path keeps it exact.
    expect(await parseFileSymbols(path.join(dir, 'missing.ts'))).toEqual([]);
    expect((await parseFileSymbols(file)).length).toBeGreaterThan(0);
  });

  it('astOutline drops text; findSymbol round-trips exact text', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'zelari-ast-'));
    const file = path.join(dir, 'sample.ts');
    await writeFile(file, SAMPLE, 'utf8');
    const outline = await astOutline(file);
    expect(outline.every((s) => !('text' in s))).toBe(true);
    const sym = await findSymbol(file, 'Circle');
    expect(sym?.text.startsWith('export class Circle')).toBe(true);
    expect(await findSymbol(file, 'DoesNotExist')).toBeNull();
    expect(await findSymbol(path.join(dir, 'missing.ts'), 'X')).toBeNull();
  });
});
