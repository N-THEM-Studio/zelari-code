import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { grepContentTool, GrepContentArgsSchema } from './search.js';
import type { ToolContext } from '../toolTypes.js';

/**
 * WS1 — grep_content auto-diagnostico (piano §1 + delta §7/§8).
 *
 * Fixture: root/{a.ts, sub/b.ts, sub/deep/c.ts} — every file contains "alpha".
 * The one-segment glob "*.ts" matches only a.ts; the recursive double-star
 * form matches all three (see _walk.ts globToRegex).
 */

let root: string;

function makeCtx(cwd: string): ToolContext {
  return {
    signal: new AbortController().signal,
    cwd,
    audit: () => {},
    sessionId: 'test-search',
  };
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-grep-ws1-'));
  await fs.mkdir(path.join(root, 'sub', 'deep'), { recursive: true });
  await fs.writeFile(path.join(root, 'a.ts'), 'alpha\n');
  await fs.writeFile(path.join(root, 'sub', 'b.ts'), 'alpha\n');
  await fs.writeFile(path.join(root, 'sub', 'deep', 'c.ts'), 'alpha\n');
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

type Exec = Awaited<ReturnType<typeof grepContentTool.execute>>;

async function run(args: Record<string, unknown>): Promise<Extract<Exec, { ok: true }>['value']> {
  // Parse defaults exactly like the real registry does (maxDepth, include, …).
  const parsed = GrepContentArgsSchema.parse(args);
  const res = await grepContentTool.execute(parsed, makeCtx(root));
  if (!res.ok) throw new Error(`tool failed: ${res.error}`);
  return res.value;
}

describe('grep_content — WS1 filesWalked + warnings', () => {
  it('non-recursive glob: warns and reports filesWalked vs filesInTree', async () => {
    const r = await run({ path: root, pattern: 'alpha', contextLines: 0, maxMatches: 50, include: ['*.ts'] });
    expect(r.filesWalked).toBe(3);
    expect(r.filesInTree).toBe(1);
    expect(r.totalMatches).toBe(1);
    expect(r.warning).toBeDefined();
    expect(r.warning).toContain('**/*.ts');
    expect(r.effectiveInclude).toEqual(['*.ts']);
  });

  it('recursive glob: no warning, all files matched', async () => {
    const r = await run({ path: root, pattern: 'alpha', contextLines: 0, maxMatches: 50, include: ['**/*.ts'] });
    expect(r.filesWalked).toBe(3);
    expect(r.filesInTree).toBe(3);
    expect(r.totalMatches).toBe(3);
    expect(r.warning).toBeUndefined();
  });

  it('default include (omitted): all files, no warning', async () => {
    const r = await run({ path: root, pattern: 'alpha', contextLines: 0, maxMatches: 50 });
    expect(r.filesInTree).toBe(3);
    expect(r.totalMatches).toBe(3);
    expect(r.warning).toBeUndefined();
    expect(r.effectiveInclude).toEqual(['*']);
  });

  it('empty include array: DEPRECATED_INPUT sentinel, documented fallback to ["*"] (v1.46 window)', async () => {
    const r = await run({ path: root, pattern: 'alpha', contextLines: 0, maxMatches: 50, include: [] });
    expect(r.warning).toContain('DEPRECATED_INPUT');
    expect(r.warning).toContain('INVALID_ARGUMENT');
    expect(r.effectiveInclude).toEqual(['*']);
    expect(r.filesInTree).toBe(3); // fallback '*' = all files
  });

  it('bare-string include: coercion warning echoing the effective value', async () => {
    const r = await run({ path: root, pattern: 'alpha', contextLines: 0, maxMatches: 50, include: '*.ts' });
    expect(r.warning).toContain('coerced');
    expect(r.effectiveInclude).toEqual(['*.ts']);
    expect(r.filesInTree).toBe(1);
  });

  it('include matching 0 of N walked files: SEARCH_EMPTY_SCOPE sentinel, model-facing', async () => {
    const r = await run({ path: root, pattern: 'alpha', contextLines: 0, maxMatches: 50, include: ['*.nomatch'] });
    expect(r.filesWalked).toBe(3);
    expect(r.filesInTree).toBe(0);
    expect(r.totalMatches).toBe(0);
    expect(r.warning).toContain('SEARCH_EMPTY_SCOPE');
    expect(r.warning).toContain('Do not interpret this result as "pattern not found"');
  });

  it('intentional narrow filter with no recursive gain: stays silent (no false-positive noise)', async () => {
    // '*.zzz' at root only would not match more with '**/' — but it matches 0
    // files, so the sentinel fires by design. Use a literal single-file glob
    // that DOES match to prove a narrow-but-correct filter is silent.
    const r = await run({ path: root, pattern: 'alpha', contextLines: 0, maxMatches: 50, include: ['a.ts'] });
    expect(r.filesInTree).toBe(1);
    expect(r.totalMatches).toBe(1);
    expect(r.warning).toBeUndefined();
  });

  it('single-file mode: filesWalked/filesSearched = 1, no scope warning', async () => {
    const r = await run({ path: path.join(root, 'a.ts'), pattern: 'alpha', contextLines: 0, maxMatches: 50 });
    expect(r.filesWalked).toBe(1);
    expect(r.filesSearched).toBe(1);
    expect(r.filesInTree).toBe(1);
    expect(r.totalMatches).toBe(1);
    expect(r.warning).toBeUndefined();
  });
});
