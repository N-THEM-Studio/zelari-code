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
 * A flat glob like "*.ts" is matchBase (grep --include style): it matches the
 * basename at any depth, so it selects all three files. The recursive
 * double-star form is equivalent here (see _walk.ts filterByInclude).
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
  it('flat glob: matches basename at any depth (grep --include), no hint', async () => {
    const r = await run({ path: root, pattern: 'alpha', contextLines: 0, maxMatches: 50, include: ['*.ts'] });
    expect(r.filesWalked).toBe(3);
    expect(r.filesInTree).toBe(3);
    expect(r.totalMatches).toBe(3);
    expect(r.warning).toBeUndefined();
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
    expect(r.filesInTree).toBe(3);
    expect(r.warning).not.toContain('**/*.ts'); // no recursive hint for flat globs
  });

  it('include matching 0 of N walked files: SEARCH_EMPTY_SCOPE sentinel, model-facing', async () => {
    const r = await run({ path: root, pattern: 'alpha', contextLines: 0, maxMatches: 50, include: ['*.nomatch'] });
    expect(r.filesWalked).toBe(3);
    expect(r.filesInTree).toBe(0);
    expect(r.totalMatches).toBe(0);
    expect(r.warning).toContain('SEARCH_EMPTY_SCOPE');
    expect(r.warning).toContain('Do not interpret this result as "pattern not found"');
    expect(r.warning).not.toContain("'*' matches only one path segment"); // stale advice
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

describe('grep_content — path-anchored globs keep the recursive hint', () => {
  let root2: string;

  beforeAll(async () => {
    root2 = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-grep-anchored-'));
    await fs.mkdir(path.join(root2, 'src'), { recursive: true });
    await fs.mkdir(path.join(root2, 'lib', 'src'), { recursive: true });
    await fs.writeFile(path.join(root2, 'src', 'x.ts'), 'alpha\n');
    await fs.writeFile(path.join(root2, 'lib', 'src', 'y.ts'), 'alpha\n');
  });

  afterAll(async () => {
    await fs.rm(root2, { recursive: true, force: true });
  });

  async function runIn(cwd: string, args: Record<string, unknown>) {
    const parsed = GrepContentArgsSchema.parse(args);
    const res = await grepContentTool.execute(parsed, makeCtx(cwd));
    if (!res.ok) throw new Error(`tool failed: ${res.error}`);
    return res.value;
  }

  it('anchored glob the ** form would widen: hint fires with the glob echoed', async () => {
    // 'src/*.ts' matches src/x.ts only; '**/src/*.ts' would also match lib/src/y.ts
    const r = await runIn(root2, { path: root2, pattern: 'alpha', contextLines: 0, maxMatches: 50, include: ['src/*.ts'] });
    expect(r.filesWalked).toBe(2);
    expect(r.filesInTree).toBe(1);
    expect(r.warning).toContain("a '**/src/*.ts'");
    expect(r.warning).toContain('would have matched 1 more');
  });

  it('flat glob over the same tree: reaches lib/src/y.ts via basename, silent', async () => {
    const r = await runIn(root2, { path: root2, pattern: 'alpha', contextLines: 0, maxMatches: 50, include: ['*.ts'] });
    expect(r.filesInTree).toBe(2);
    expect(r.warning).toBeUndefined();
  });
});
