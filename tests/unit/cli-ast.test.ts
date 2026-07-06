import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { astOutline, findSymbol, isAstSupported } from '../../src/cli/ast/engine.js';
import { createBuiltinToolRegistry } from '../../src/cli/toolRegistry.js';

const SAMPLE = `import { x } from './x';

export function greet(name: string): string {
  return 'hi ' + name;
}

const helper = (n: number) => n * 2;

export const CONFIG = { a: 1 };

export interface Widget {
  id: string;
}

export type Id = string;

export enum Color { Red, Green }

export class Service {
  private value = 0;
  run(): number {
    return this.value;
  }
}
`;

describe('ast engine', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ast-'));
    file = path.join(dir, 'sample.ts');
    writeFileSync(file, SAMPLE);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('isAstSupported gates on extension', () => {
    expect(isAstSupported('a.ts')).toBe(true);
    expect(isAstSupported('a.TSX')).toBe(true);
    expect(isAstSupported('a.md')).toBe(false);
  });

  it('outlines every declaration with kind, export flag, and line ranges', async () => {
    const outline = await astOutline(file);
    const by = (name: string) => outline.find((s) => s.name === name);

    expect(by('greet')).toMatchObject({ kind: 'function', exported: true });
    expect(by('helper')).toMatchObject({ kind: 'function', exported: false });
    expect(by('CONFIG')).toMatchObject({ kind: 'variable', exported: true });
    expect(by('Widget')).toMatchObject({ kind: 'interface', exported: true });
    expect(by('Id')).toMatchObject({ kind: 'type', exported: true });
    expect(by('Color')).toMatchObject({ kind: 'enum', exported: true });
    expect(by('Service')).toMatchObject({ kind: 'class', exported: true });
    expect(by('run')).toMatchObject({ kind: 'method' });
    // greet spans lines 3-5 in the sample.
    expect(by('greet')!.line).toBe(3);
    expect(by('greet')!.endLine).toBe(5);
  });

  it('findSymbol returns the exact source text of a declaration', async () => {
    const sym = await findSymbol(file, 'greet');
    expect(sym).not.toBeNull();
    expect(sym!.kind).toBe('function');
    expect(sym!.text).toContain("return 'hi ' + name;");
    expect(sym!.text.startsWith('export function greet')).toBe(true);
  });

  it('findSymbol locates a class method', async () => {
    const sym = await findSymbol(file, 'run');
    expect(sym?.kind).toBe('method');
    expect(sym!.text).toContain('return this.value;');
  });

  it('returns null / [] for unknown symbols and unsupported files', async () => {
    expect(await findSymbol(file, 'nope')).toBeNull();
    const md = path.join(dir, 'readme.md');
    writeFileSync(md, '# hi');
    expect(await astOutline(md)).toEqual([]);
    expect(await findSymbol(md, 'x')).toBeNull();
  });
});

describe('ast tools in the registry', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'ast-reg-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('are registered in the full registry', () => {
    const { tools } = createBuiltinToolRegistry({ root, lspProvider: null });
    const names = tools.map((t) => t.name);
    expect(names).toContain('ast_outline');
    expect(names).toContain('find_symbol');
  });

  it('are also available to read-only sub-agents (read-only analysis)', () => {
    const { registry } = createBuiltinToolRegistry({ root, readOnly: true });
    expect(registry.get('ast_outline')).toBeDefined();
    expect(registry.get('find_symbol')).toBeDefined();
    // still no write/task even with ast on
    expect(registry.get('write_file')).toBeUndefined();
    expect(registry.get('task')).toBeUndefined();
  });
});
