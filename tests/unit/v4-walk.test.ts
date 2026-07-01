import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { walk, matchesAny, filterByInclude, DEFAULT_EXCLUDES, type FileEntry } from '../../src/main/core/tools/builtin/_walk.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-walk-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function makeTree(structure: Record<string, string | null>) {
  for (const [rel, content] of Object.entries(structure)) {
    const abs = path.join(tmpRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    if (content === null) {
      await fs.mkdir(abs, { recursive: true });
    } else {
      await fs.writeFile(abs, content);
    }
  }
}

describe('_walk', () => {
  describe('matchesAny (glob matching)', () => {
    it('matches literal name', () => {
      expect(matchesAny('foo.txt', ['foo.txt'])).toBe(true);
      expect(matchesAny('bar.txt', ['foo.txt'])).toBe(false);
    });

    it('handles * wildcard within segment', () => {
      expect(matchesAny('foo.ts', ['*.ts'])).toBe(true);
      expect(matchesAny('foo.tsx', ['*.ts'])).toBe(false);
    });

    it('handles ? wildcard', () => {
      expect(matchesAny('foo.ts', ['fo?.ts'])).toBe(true);
      expect(matchesAny('fooo.ts', ['fo?.ts'])).toBe(false);
    });

    it('handles char class [abc]', () => {
      expect(matchesAny('a.ts', ['[abc].ts'])).toBe(true);
      expect(matchesAny('z.ts', ['[abc].ts'])).toBe(false);
    });

    it('handles ** (recursive wildcard)', () => {
      expect(matchesAny('a/b/c.ts', ['**/*.ts'])).toBe(true);
      expect(matchesAny('a/b/c.ts', ['a/**/*.ts'])).toBe(true);
    });
  });

  describe('walk()', () => {
    it('walks a shallow tree with maxDepth=1 (only root entries)', async () => {
      await makeTree({
        'file1.ts': 'a',
        'file2.ts': 'b',
        'sub/file3.ts': 'c',
      });
      const entries: FileEntry[] = [];
      // depth=0, maxDepth=1 → do NOT descend into subdirectories
      await walk(tmpRoot, '', 0, 0, DEFAULT_EXCLUDES, entries, undefined);
      const names = entries.map(e => e.name).sort();
      expect(names).toContain('file1.ts');
      expect(names).toContain('file2.ts');
      expect(names).toContain('sub');
      expect(names).not.toContain('sub/file3.ts');
    });

    it('walks recursively with maxDepth=5', async () => {
      await makeTree({
        'a/b/c/d/e/deep.ts': 'x',
      });
      const entries: FileEntry[] = [];
      await walk(tmpRoot, '', 0, 5, [], entries, undefined);
      expect(entries.map(e => e.name)).toContain('a/b/c/d/e/deep.ts');
    });

    it('honors exclude patterns (node_modules, dist)', async () => {
      await makeTree({
        'src/app.ts': 'ok',
        'node_modules/foo.ts': 'no',
        'dist/bundle.js': 'no',
      });
      const entries: FileEntry[] = [];
      await walk(tmpRoot, '', 0, 5, DEFAULT_EXCLUDES, entries, undefined);
      const names = entries.map(e => e.name);
      expect(names).toContain('src/app.ts');
      expect(names.some(n => n.includes('node_modules'))).toBe(false);
      expect(names.some(n => n.includes('dist/'))).toBe(false);
    });

    it('silently skips unreadable subdirs', async () => {
      await makeTree({
        'ok.ts': 'a',
      });
      const entries: FileEntry[] = [];
      // Should not throw on missing dir (root might not exist scenario)
      await walk(path.join(tmpRoot, 'nonexistent'), '', 0, 3, [], entries, undefined);
      expect(entries).toEqual([]);
    });
  });

  describe('filterByInclude()', () => {
    const entries: FileEntry[] = [
      { name: 'foo.ts', type: 'file' },
      { name: 'foo.md', type: 'file' },
      { name: 'bar.tsx', type: 'file' },
      { name: 'sub', type: 'directory' },
      { name: 'src/app.ts', type: 'file' },
    ];

    it('returns all files when include=["*"]', () => {
      const filtered = filterByInclude(entries, ['*']);
      expect(filtered.length).toBe(4); // excludes the directory
    });

    it('filters by extension glob (single segment only)', () => {
      // *.ts → only matches files in root segment (no slashes)
      const filtered = filterByInclude(entries, ['*.ts']);
      const names = filtered.map(e => e.name).sort();
      expect(names).toEqual(['foo.ts']);
    });

    it('supports ** recursive include (matches nested too)', () => {
      const filtered = filterByInclude(entries, ['**/*.ts']);
      const names = filtered.map(e => e.name).sort();
      expect(names).toEqual(['foo.ts', 'src/app.ts']);
    });

    it('drops directories even if glob matches', () => {
      const filtered = filterByInclude(entries, ['**']);
      expect(filtered.every(e => e.type === 'file')).toBe(true);
    });
  });
});