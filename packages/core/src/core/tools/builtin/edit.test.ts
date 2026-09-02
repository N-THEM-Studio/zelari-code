import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { editTool, applyAnchoredEdit, WriteRejectSchema } from './edit.js';
import { readFileTool, snapshotIdOf } from './filesystem.js';
import { getHarnessToolDefinitions } from '../../../agents/harnessToolBridge.js';
import type { ToolContext } from '../toolTypes.js';

let tmpRoot: string;
let ctx: ToolContext;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-anchored-'));
  ctx = {
    cwd: tmpRoot,
    signal: new AbortController().signal,
    audit: () => {},
    sessionId: 'test-anchored',
  };
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const sha16 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

async function readSnap(rel: string): Promise<string> {
  const r = await readFileTool.execute({ path: rel, maxBytes: 1_000_000 }, ctx);
  if (!r.ok) throw new Error(`read failed: ${r.error}`);
  return r.value.snapshotId;
}

describe('read_file snapshotId (t72)', () => {
  it('is a stable sha256[:16] of the full pre-truncation content, in data AND meta', async () => {
    const body = 'alpha\nbeta\ngamma\n';
    await fs.writeFile(path.join(tmpRoot, 'a.txt'), body);
    const r1 = await readFileTool.execute({ path: 'a.txt', maxBytes: 1_000_000 }, ctx);
    const r2 = await readFileTool.execute({ path: 'a.txt', maxBytes: 1_000_000 }, ctx);
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.value.snapshotId).toBe(sha16(body));
      expect(r2.value.snapshotId).toBe(r1.value.snapshotId); // deterministic
      expect(r1.value.snapshotId).toMatch(/^[0-9a-f]{16}$/);
      expect(r1.meta?.snapshotId).toBe(r1.value.snapshotId);
    }
  });

  it('truncated/partial reads keep the FULL-content anchor; changed content changes it', async () => {
    await fs.writeFile(path.join(tmpRoot, 'b.txt'), 'line1\nline2\nline3\n');
    const full = await readFileTool.execute({ path: 'b.txt', maxBytes: 1_000_000 }, ctx);
    const part = await readFileTool.execute({ path: 'b.txt', startLine: 0, endLine: 2, maxBytes: 6 }, ctx);
    expect(full.ok && part.ok).toBe(true);
    if (full.ok && part.ok) {
      expect(part.meta?.warnings).toContain('MAX_BYTES_TRUNCATED');
      expect(part.value.snapshotId).toBe(full.value.snapshotId); // pre-truncation anchor
    }
    await fs.writeFile(path.join(tmpRoot, 'b.txt'), 'line1\nlineX\nline3\n');
    const after = await readFileTool.execute({ path: 'b.txt', maxBytes: 1_000_000 }, ctx);
    expect(after.ok && full.ok).toBe(true);
    if (after.ok && full.ok) expect(after.value.snapshotId).not.toBe(full.value.snapshotId);
  });
});

describe('edit tool (t73)', () => {
  it('applies with a fresh snapshot and returns the NEW snapshotId', async () => {
    await fs.writeFile(path.join(tmpRoot, 'c.txt'), 'const a = 1;\nconst b = 2;\n');
    const snap = await readSnap('c.txt');
    const r = await editTool.execute(
      { path: 'c.txt', oldString: 'const a = 1;', newString: 'const a = 41;', snapshotId: snap, replaceAll: false },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.applied).toBe(true);
      expect(r.value.occurrencesReplaced).toBe(1);
      expect(r.value.snapshotId).toBe(sha16('const a = 41;\nconst b = 2;\n'));
      expect(r.value.bytesWritten).toBe('const a = 41;\nconst b = 2;\n'.length);
    }
    expect(await fs.readFile(path.join(tmpRoot, 'c.txt'), 'utf-8')).toBe('const a = 41;\nconst b = 2;\n');
  });

  it('rejects stale_snapshot WITHOUT applying when the file changed since read', async () => {
    const mutated = 'mutated by another tentacle\n';
    await fs.writeFile(path.join(tmpRoot, 'stale.txt'), 'original\n');
    const snap = await readSnap('stale.txt');
    await fs.writeFile(path.join(tmpRoot, 'stale.txt'), mutated);
    const r = await editTool.execute(
      { path: 'stale.txt', oldString: 'original', newString: 'x', snapshotId: snap, replaceAll: false },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('edit: stale_snapshot:');
      const reject = WriteRejectSchema.parse(r.meta?.reject);
      expect(reject.status).toBe('stale_snapshot');
      expect(reject.expectedHash).toBe(snap);
      expect(reject.actualHash).toBe(sha16(mutated));
      expect(reject.next).toEqual({ action: 're-read', path: path.join(tmpRoot, 'stale.txt') });
      expect(r.meta?.warnings).toContain('STALE_SNAPSHOT');
    }
    expect(await fs.readFile(path.join(tmpRoot, 'stale.txt'), 'utf-8')).toBe(mutated);
  });

  it('rejects hunk_mismatch with minimalDiff and span — never relocates', async () => {
    const original = 'alpha one\nalpha two\nunrelated\n';
    await fs.writeFile(path.join(tmpRoot, 'm.txt'), original);
    const snap = await readSnap('m.txt');
    const r = await editTool.execute(
      { path: 'm.txt', oldString: 'alpha three', newString: 'X', snapshotId: snap, replaceAll: false },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('edit: hunk_mismatch:');
      const reject = WriteRejectSchema.parse(r.meta?.reject);
      expect(reject.status).toBe('hunk_mismatch');
      expect(reject.minimalDiff.length).toBeGreaterThan(0);
      expect(reject.minimalDiff).toContain('+alpha three'); // expected-but-missing line
      expect(reject.span).toBeDefined();
      expect(reject.next.action).toBe('re-read');
    }
    expect(await fs.readFile(path.join(tmpRoot, 'm.txt'), 'utf-8')).toBe(original);
  });

  it('CRLF end-to-end: LF oldString applies, CRLF preserved, new anchor matches disk', async () => {
    const after = 'const x = 9;\r\nconst y = 2;\r\n';
    await fs.writeFile(path.join(tmpRoot, 'crlf.ts'), 'const x = 1;\r\nconst y = 2;\r\n', 'utf-8');
    const snap = await readSnap('crlf.ts');
    const r = await editTool.execute(
      { path: 'crlf.ts', oldString: 'const x = 1;\n', newString: 'const x = 9;\n', snapshotId: snap, replaceAll: false },
      ctx,
    );
    expect(r.ok).toBe(true);
    const written = await fs.readFile(path.join(tmpRoot, 'crlf.ts'), 'utf-8');
    expect(written).toBe(after);
    if (r.ok) {
      expect(r.value.snapshotId).toBe(sha16(after));
      expect(await readSnap('crlf.ts')).toBe(r.value.snapshotId); // round-trip anchor
    }
  });

  it('missing file → named FILE_NOT_FOUND failure', async () => {
    const r = await editTool.execute(
      { path: 'nope.txt', oldString: 'a', newString: 'b', snapshotId: sha16('a'), replaceAll: false },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('FILE_NOT_FOUND');
      expect(r.meta?.warnings).toContain('FILE_NOT_FOUND');
    }
  });
});

describe('applyAnchoredEdit engine', () => {
  it('gate order: stale_snapshot wins over hunk_mismatch (no apply attempt on stale)', async () => {
    const r = applyAnchoredEdit({
      content: 'changed\n',
      expectedSnapshotId: sha16('not what is on disk\n'),
      oldString: 'missing everywhere',
      newString: 'x',
      replaceAll: false,
      path: 'p.txt',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reject.status).toBe('stale_snapshot');
      expect(r.reject.actualHash).toBe(sha16('changed\n'));
    }
  });

  it('gate 2 uses replaceFileString tolerances only (CRLF) and re-anchors the result', () => {
    const r = applyAnchoredEdit({
      content: 'a\r\nb\r\n',
      expectedSnapshotId: snapshotIdOf('a\r\nb\r\n'),
      oldString: 'b\n',
      newString: 'B\n',
      replaceAll: false,
      path: 'p.txt',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.newContent).toBe('a\r\nB\r\n');
      expect(r.snapshotId).toBe(snapshotIdOf('a\r\nB\r\n'));
    }
  });
});

describe('WriteRejectSchema (day-1 shape)', () => {
  const good = {
    ok: false,
    status: 'stale_snapshot',
    path: 'p.txt',
    expectedHash: '0123456789abcdef',
    actualHash: 'ffffffffffffffff',
    minimalDiff: '',
    next: { action: 're-read', path: 'p.txt' },
  } as const;

  it('accepts a valid reject (with optional span)', () => {
    expect(WriteRejectSchema.safeParse(good).success).toBe(true);
    expect(
      WriteRejectSchema.safeParse({ ...good, status: 'hunk_mismatch', span: { startLine: 2, endLine: 5 } })
        .success,
    ).toBe(true);
  });

  it('rejects prose statuses, missing minimalDiff, and foreign next actions', () => {
    expect(WriteRejectSchema.safeParse({ ...good, status: 'nope' }).success).toBe(false);
    expect(WriteRejectSchema.safeParse({ ...good, minimalDiff: undefined }).success).toBe(false);
    expect(WriteRejectSchema.safeParse({ ...good, next: { action: 'retry', path: 'p.txt' } }).success).toBe(false);
  });
});

describe('tool registration', () => {
  it('edit is registered in the harness builtin catalog', () => {
    const names = getHarnessToolDefinitions().map((t) => t.name);
    expect(names).toContain('edit');
    expect(names).toContain('read_file');
    expect(names).toContain('apply_diff');
  });
});
