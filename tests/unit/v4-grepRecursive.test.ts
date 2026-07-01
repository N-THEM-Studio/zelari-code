import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { grepContentTool } from '../../src/main/core/tools/builtin/search.js';
import { GrepContentArgsSchema } from '../../src/main/core/tools/builtin/search.js';
import type { ToolContext } from '../../src/main/core/tools/toolTypes.js';

let tmpRoot: string;
let ctx: ToolContext;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-grep-'));
  ctx = { cwd: tmpRoot, signal: undefined as unknown as AbortSignal };
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function makeTree(structure: Record<string, string>) {
  for (const [rel, content] of Object.entries(structure)) {
    const abs = path.join(tmpRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
}

function unwrap<T>(result: { ok: boolean; value?: T; error?: { message: string } | string }): T {
  if (!result.ok) {
    const err = typeof result.error === 'string' ? result.error : result.error?.message;
    throw new Error(`tool failed: ${err}`);
  }
  return result.value as T;
}

/** Parse args through Zod so defaults apply (matches production flow). */
function run(rawArgs: Record<string, unknown>) {
  const parsed = GrepContentArgsSchema.parse(rawArgs);
  return grepContentTool.execute(parsed, ctx);
}

describe('grep_content (v0.4.0: recursive mode)', () => {
  describe('single-file mode (backward compat)', () => {
    it('matches a regex in a single file', async () => {
      await makeTree({ 'app.ts': 'hello world\nfoo bar\nhello again' });
      const r = unwrap(await run({ path: 'app.ts', pattern: 'hello' }, ctx));
      expect(r.totalMatches).toBe(2);
      expect(r.matches).toHaveLength(2);
      expect(r.matches[0].line).toBe(1);
      expect(r.matches[1].line).toBe(3);
      expect(r.filesSearched).toBe(1);
      expect(r.filesInTree).toBe(1);
    });

    it('returns 0 matches without throwing', async () => {
      await makeTree({ 'app.ts': 'no match here' });
      const r = unwrap(await run({ path: 'app.ts', pattern: 'xxx' }, ctx));
      expect(r.totalMatches).toBe(0);
      expect(r.matches).toEqual([]);
    });

    it('respects contextLines', async () => {
      await makeTree({ 'app.ts': 'a\nb\nc\nTARGET\nd\ne\nf' });
      const r = unwrap(await run({ path: 'app.ts', pattern: 'TARGET', contextLines: 2 }, ctx));
      expect(r.matches[0].line).toBe(4);
      expect(r.matches[0].context.before).toEqual(['b', 'c']);
      expect(r.matches[0].context.after).toEqual(['d', 'e']);
    });
  });

  describe('recursive mode (directory)', () => {
    it('searches all .ts files in a directory tree', async () => {
      await makeTree({
        'src/a.ts': 'TARGET here',
        'src/c.ts': 'TARGET there',
        'src/readme.md': 'TARGET in md',
      });
      const r = unwrap(await run({ path: 'src', pattern: 'TARGET', include: ['*.ts'] }, ctx));
      expect(r.totalMatches).toBe(2);
      expect(r.matches).toHaveLength(2);
      expect(r.filesSearched).toBe(2);
      expect(r.filesInTree).toBe(2);
    });

    it('honors exclude patterns (skips node_modules)', async () => {
      await makeTree({
        'src/app.ts': 'TARGET',
        'node_modules/foo.ts': 'TARGET',
      });
      const r = unwrap(await run({ path: '.', pattern: 'TARGET' }, ctx));
      expect(r.totalMatches).toBe(1);
      expect(r.matches[0].relPath).toBe('src/app.ts');
    });

    it('supports ** recursive glob in include', async () => {
      await makeTree({
        'src/a.ts': 'TARGET',
        'src/nested/deep/b.ts': 'TARGET',
        'docs/readme.md': 'TARGET',
      });
      const r = unwrap(await run({ path: '.', pattern: 'TARGET', include: ['**/*.ts'] }, ctx));
      expect(r.filesSearched).toBe(2);
      expect(r.matches.every(m => m.relPath.endsWith('.ts'))).toBe(true);
    });

    it('respects maxDepth', async () => {
      await makeTree({
        'a/b/c/d/deep.ts': 'TARGET',
      });
      const r = unwrap(await run({ path: '.', pattern: 'TARGET', maxDepth: 2 }, ctx));
      expect(r.totalMatches).toBe(0);
      expect(r.filesSearched).toBe(0);
    });

    it('respects maxMatches (truncates results)', async () => {
      await makeTree({
        'src/a.ts': Array.from({ length: 10 }, (_, i) => `TARGET ${i}`).join('\n'),
      });
      const r = unwrap(await run({ path: 'src', pattern: 'TARGET', maxMatches: 3 }, ctx));
      expect(r.matches.length).toBe(3);
      expect(r.totalMatches).toBe(10);
      expect(r.truncated).toBe(true);
    });

    it('handles empty directory gracefully', async () => {
      await fs.mkdir(path.join(tmpRoot, 'empty'), { recursive: true });
      const r = unwrap(await run({ path: 'empty', pattern: 'anything' }, ctx));
      expect(r.matches).toEqual([]);
      expect(r.filesSearched).toBe(0);
    });
  });
});