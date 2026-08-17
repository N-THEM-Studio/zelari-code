import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { grepContentTool } from './search.js';
import { listFilesTool } from './listFiles.js';
import { readFileTool } from './filesystem.js';
import { metaFooter, type ToolContext } from '../toolTypes.js';

let tmpDir: string;
let ctx: ToolContext;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-gt-'));
  ctx = {
    signal: new AbortController().signal,
    cwd: tmpDir,
    audit: () => {},
    sessionId: 'test-ground-truth',
  };
  // Fixture: a small tree with a few files.
  await fs.writeFile(path.join(tmpDir, 'alpha.ts'), 'export const a = 1;\nexport const b = 2;\n');
  await fs.writeFile(path.join(tmpDir, 'beta.md'), '# beta\n');
  await fs.mkdir(path.join(tmpDir, 'emptydir'));
  await fs.writeFile(path.join(tmpDir, 'zero.txt'), '');
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('metaFooter', () => {
  it('returns empty string for absent meta and clean-complete observations', () => {
    expect(metaFooter(undefined)).toBe('');
    expect(metaFooter({ status: 'complete' })).toBe('');
    expect(metaFooter({ status: 'complete', counts: { matches: 3 } })).toBe('');
  });

  it('renders a deterministic single-line footer for non-clean observations', () => {
    const a = metaFooter({ status: 'empty', warnings: ['SEARCH_EMPTY_SCOPE'], counts: { filesWalked: 0 } });
    const b = metaFooter({ status: 'empty', warnings: ['SEARCH_EMPTY_SCOPE'], counts: { filesWalked: 0 } });
    expect(a).toBe(b);
    expect(a).toContain('status=empty');
    expect(a).toContain('warnings=SEARCH_EMPTY_SCOPE');
    expect(a).toContain('filesWalked=0');
    expect(a.startsWith('\n[observation ')).toBe(true);
  });
});

describe('grep_content ground truth meta', () => {
  it('single-file: complete with match counts', async () => {
    const r = await grepContentTool.execute(
      { path: 'alpha.ts', pattern: 'export', contextLines: 0, maxMatches: 50, include: ['*'], exclude: [], maxDepth: 8 },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.meta?.status).toBe('complete');
      expect(r.meta?.counts?.matches).toBe(2);
      expect(r.meta?.counts?.filesWalked).toBe(1);
    }
  });

  it('single-file: FILE_NOT_FOUND failure with named warning', async () => {
    const r = await grepContentTool.execute(
      { path: 'nope.ts', pattern: 'x', contextLines: 0, maxMatches: 50, include: ['*'], exclude: [], maxDepth: 8 },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('FILE_NOT_FOUND');
      expect(r.meta?.status).toBe('failed');
      expect(r.meta?.warnings).toContain('FILE_NOT_FOUND');
    }
  });

  it('directory: SEARCH_EMPTY_SCOPE when include globs match nothing', async () => {
    const r = await grepContentTool.execute(
      { path: tmpDir, pattern: 'export', contextLines: 0, maxMatches: 50, include: ['*.nomatch'], exclude: [], maxDepth: 2 },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.meta?.status).toBe('empty');
      expect(r.meta?.warnings).toContain('SEARCH_EMPTY_SCOPE');
    }
  });

  it('directory: TREE_EMPTY on an empty directory', async () => {
    const r = await grepContentTool.execute(
      { path: 'emptydir', pattern: 'x', contextLines: 0, maxMatches: 50, include: ['*'], exclude: [], maxDepth: 2 },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.meta?.status).toBe('empty');
      expect(r.meta?.warnings).toContain('TREE_EMPTY');
    }
  });

  it('directory: complete with 0 matches is COMPLETE, not empty (negative result is valid)', async () => {
    const r = await grepContentTool.execute(
      { path: tmpDir, pattern: 'zzz_no_such_symbol', contextLines: 0, maxMatches: 50, include: ['*'], exclude: [], maxDepth: 2 },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.meta?.status).toBe('complete');
      expect(r.meta?.counts?.matches).toBe(0);
      expect((r.meta?.warnings ?? []).length).toBe(0);
    }
  });

  it('directory: partial when maxMatches truncates', async () => {
    const r = await grepContentTool.execute(
      { path: tmpDir, pattern: 'export', contextLines: 0, maxMatches: 1, include: ['*'], exclude: [], maxDepth: 2 },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.meta?.status).toBe('partial');
      expect(r.meta?.truncated).toBe(true);
    }
  });
});

describe('read_file ground truth meta', () => {
  it('complete with byte/line counts', async () => {
    const r = await readFileTool.execute({ path: 'alpha.ts', maxBytes: 1_000_000 }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.meta?.status).toBe('complete');
      expect(r.meta?.counts?.lines).toBe(3);
      expect(r.meta?.counts?.bytes).toBeGreaterThan(0);
    }
  });

  it('EMPTY_FILE status for a zero-byte file', async () => {
    const r = await readFileTool.execute({ path: 'zero.txt', maxBytes: 1_000_000 }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.meta?.status).toBe('empty');
      expect(r.meta?.warnings).toContain('EMPTY_FILE');
    }
  });

  it('FILE_NOT_FOUND named failure for missing file', async () => {
    const r = await readFileTool.execute({ path: 'missing.ts', maxBytes: 1000 }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.meta?.status).toBe('failed');
      expect(r.meta?.warnings).toContain('FILE_NOT_FOUND');
    }
  });

  it('partial + MAX_BYTES_TRUNCATED when the cap cuts the payload', async () => {
    const r = await readFileTool.execute({ path: 'alpha.ts', maxBytes: 10 }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.meta?.status).toBe('partial');
      expect(r.meta?.warnings).toContain('MAX_BYTES_TRUNCATED');
      expect(r.meta?.truncated).toBe(true);
    }
  });
});

describe('list_files ground truth meta', () => {
  it('complete with entry count', async () => {
    const r = await listFilesTool.execute({ maxDepth: 1, exclude: [] }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.meta?.status).toBe('complete');
      expect(r.meta?.counts?.filesWalked).toBeGreaterThan(0);
    }
  });

  it('DIR_EMPTY for an empty directory', async () => {
    const r = await listFilesTool.execute({ path: 'emptydir', maxDepth: 1, exclude: [] }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.meta?.status).toBe('empty');
      expect(r.meta?.warnings).toContain('DIR_EMPTY');
    }
  });
});
