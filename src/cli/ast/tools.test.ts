/**
 * S2.0/S2.2/S2.3 — tool-level tests: root propagation, ctx.cwd resolution,
 * loud degraded notes with machine fields, and "found: false only when the
 * file was actually read and parsed".
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createAstTools } from './tools.js';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';

const SAMPLE = [
  'export interface Shape { kind: string }',
  'export class Circle implements Shape {',
  '  kind = "circle";',
  '  area(): number { return 1; }',
  '}',
  'export const area = (r: number): number => r * r;',
  '',
].join('\n');

function fakeCtx(cwd: string): ToolContext {
  return {
    signal: new AbortController().signal,
    cwd,
    audit: () => {},
    sessionId: 'ast-tools-test',
  };
}

async function run(tool: { execute: (input: unknown, ctx: ToolContext) => Promise<{ ok: true; value: unknown } | { ok: false; error: string }> }, args: unknown, ctx: ToolContext) {
  const r = await tool.execute(args, ctx);
  if (!r.ok) throw new Error(r.error);
  return r.value as Record<string, unknown>;
}

function getTools(root: string) {
  const tools = createAstTools(root);
  const outline = tools.find((t) => t.name === 'ast_outline')!;
  const findSym = tools.find((t) => t.name === 'find_symbol')!;
  return { outline, findSym };
}

describe('ast_outline (loud degradation)', () => {
  it('resolves a RELATIVE path against ctx.cwd', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'zelari-ast-'));
    await writeFile(path.join(dir, 'sample.ts'), SAMPLE, 'utf8');
    const { outline } = getTools('/nonexistent-root');
    const v = await run(outline, { path: 'sample.ts' }, fakeCtx(dir));
    expect(v.status).toBe('ok');
    expect(v.count).toBeGreaterThan(0);
    const symbols = v.symbols as string[];
    expect(symbols.some((s) => s.includes('export class Circle'))).toBe(true);
  });

  it('falls back to the factory root when ctx has no cwd (S2.0)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'zelari-ast-'));
    await writeFile(path.join(dir, 'sample.ts'), SAMPLE, 'utf8');
    const { outline } = getTools(dir);
    const ctxNoCwd = {
      signal: new AbortController().signal,
      audit: () => {},
      sessionId: 'ast-tools-test',
    } as unknown as ToolContext;
    const v = await run(outline, { path: 'sample.ts' }, ctxNoCwd);
    expect(v.status).toBe('ok');
    expect(v.count).toBeGreaterThan(0);
  });

  it('file-not-found names the absolute path it looked at', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'zelari-ast-'));
    const { outline } = getTools('/nonexistent-root');
    const v = await run(outline, { path: 'missing.ts' }, fakeCtx(dir));
    expect(v.status).toBe('file-not-found');
    expect(v.symbols).toEqual([]);
    expect(v.note).toContain(path.join(dir, 'missing.ts'));
    expect(v.recoverable).toBe(false);
    expect(v.recommendedFallback).toBe('grep_content');
  });

  it('unsupported-extension reports the extension in the note', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'zelari-ast-'));
    await writeFile(path.join(dir, 'script.py'), 'def f(): pass\n', 'utf8');
    const { outline } = getTools('/nonexistent-root');
    const v = await run(outline, { path: 'script.py' }, fakeCtx(dir));
    expect(v.status).toBe('unsupported-extension');
    expect(v.note).toContain('.py');
  });

  it('an empty-but-parsed file is a TRUE empty, not a degraded note', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'zelari-ast-'));
    await writeFile(path.join(dir, 'empty.ts'), '\n', 'utf8');
    const { outline } = getTools('/nonexistent-root');
    const v = await run(outline, { path: 'empty.ts' }, fakeCtx(dir));
    expect(v.status).toBe('ok');
    expect(v.symbols).toEqual([]);
    expect(v.note).toContain('no declarations');
    // The old conflated three-causes note must be gone.
    expect(String(v.note)).not.toContain('TypeScript unavailable');
  });
});

describe('find_symbol (found:false only after a successful parse)', () => {
  it('degraded file surfaces status, not a fake "no declaration named"', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'zelari-ast-'));
    const { findSym } = getTools('/nonexistent-root');
    const v = await run(findSym, { path: 'missing.ts', name: 'Circle' }, fakeCtx(dir));
    expect(v.found).toBe(false);
    expect(v.status).toBe('file-not-found');
    expect(v.note).toContain(path.join(dir, 'missing.ts'));
  });

  it('symbol truly absent from a PARSED file → found:false, status ok, hint of present names', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'zelari-ast-'));
    await writeFile(path.join(dir, 'sample.ts'), SAMPLE, 'utf8');
    const { findSym } = getTools('/nonexistent-root');
    const v = await run(findSym, { path: 'sample.ts', name: 'Sphere' }, fakeCtx(dir));
    expect(v.found).toBe(false);
    expect(v.status).toBe('ok');
    expect(v.note).toContain('Sphere');
    expect(v.note).toContain('Circle');
  });

  it('returns the exact declaration text for editing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'zelari-ast-'));
    await writeFile(path.join(dir, 'sample.ts'), SAMPLE, 'utf8');
    const { findSym } = getTools('/nonexistent-root');
    const v = await run(findSym, { path: 'sample.ts', name: 'Circle' }, fakeCtx(dir));
    expect(v.found).toBe(true);
    expect(v.kind).toBe('class');
    expect(v.exported).toBe(true);
    expect(String(v.text).startsWith('export class Circle')).toBe(true);
  });
});
