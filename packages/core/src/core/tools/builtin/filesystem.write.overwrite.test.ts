import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotIdOf, writeFileTool } from './filesystem.js';
import { WriteRejectSchema } from './edit.js';
import type { ToolContext } from '../toolTypes.js';

let tmpRoot: string;
let ctx: ToolContext;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-write-k22-'));
  ctx = {
    cwd: tmpRoot,
    signal: new AbortController().signal,
    audit: () => {},
    sessionId: 'test-write-k22',
  };
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('K2.2 write_file overwrite:true anchored (F10)', () => {
  it('overwrite without expectedHash/force on an existing file → stale_content, disk untouched', async () => {
    const file = path.join(tmpRoot, 'keep.ts');
    await fs.writeFile(file, 'original\n', 'utf-8');
    const r = await writeFileTool.execute(
      { path: 'keep.ts', content: 'clobber\n', overwrite: true },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(await fs.readFile(file, 'utf-8')).toBe('original\n');
    if (!r.ok) {
      expect(r.error).toMatch(/stale_content/);
      expect(r.error).toMatch(/expectedHash/);
      expect(r.error).toMatch(/force/);
      const reject = WriteRejectSchema.parse(r.meta?.reject);
      expect(reject.status).toBe('stale_content');
      expect(reject.path).toBe(file);
      expect(reject.actualHash).toBe(snapshotIdOf('original\n'));
      expect(reject.next).toEqual({ action: 're-read', path: file });
    }
  });

  it('overwrite with matching expectedHash writes', async () => {
    const file = path.join(tmpRoot, 'swap.ts');
    const original = 'old\n';
    await fs.writeFile(file, original, 'utf-8');
    const r = await writeFileTool.execute(
      {
        path: 'swap.ts',
        content: 'new\n',
        overwrite: true,
        expectedHash: snapshotIdOf(original),
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    await expect(fs.readFile(file, 'utf-8')).resolves.toBe('new\n');
    if (r.ok) expect(r.value.forcedOverwrite).toBeUndefined();
  });

  it('overwrite with wrong expectedHash → stale_content carrying actualHash, disk untouched', async () => {
    const file = path.join(tmpRoot, 'stale.ts');
    const original = 'on-disk\n';
    await fs.writeFile(file, original, 'utf-8');
    const r = await writeFileTool.execute(
      {
        path: 'stale.ts',
        content: 'incoming\n',
        overwrite: true,
        expectedHash: 'deadbeefdeadbeef',
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(await fs.readFile(file, 'utf-8')).toBe(original);
    if (!r.ok) {
      const reject = WriteRejectSchema.parse(r.meta?.reject);
      expect(reject.status).toBe('stale_content');
      expect(reject.expectedHash).toBe('deadbeefdeadbeef');
      expect(reject.actualHash).toBe(snapshotIdOf(original));
      expect(reject.next).toEqual({ action: 're-read', path: file });
    }
  });

  it('overwrite with force:true writes and marks forcedOverwrite (not silent)', async () => {
    const file = path.join(tmpRoot, 'force.ts');
    await fs.writeFile(file, 'old\n', 'utf-8');
    const r = await writeFileTool.execute(
      { path: 'force.ts', content: 'forced\n', overwrite: true, force: true },
      ctx,
    );
    expect(r.ok).toBe(true);
    await expect(fs.readFile(file, 'utf-8')).resolves.toBe('forced\n');
    if (r.ok) {
      expect(r.value.forcedOverwrite).toBe(true);
      expect(r.meta?.warnings).toContain('FORCED_OVERWRITE');
    }
  });

  it('overwrite:false on existing still file_exists (unchanged)', async () => {
    const file = path.join(tmpRoot, 'guard.ts');
    await fs.writeFile(file, 'keep\n', 'utf-8');
    const r = await writeFileTool.execute({ path: 'guard.ts', content: 'nope\n' }, ctx);
    expect(r.ok).toBe(false);
    expect(await fs.readFile(file, 'utf-8')).toBe('keep\n');
    if (!r.ok) {
      expect(WriteRejectSchema.parse(r.meta?.reject).status).toBe('file_exists');
    }
  });

  it('new file does not require expectedHash or force', async () => {
    const r = await writeFileTool.execute({ path: 'fresh.ts', content: 'hello\n' }, ctx);
    expect(r.ok).toBe(true);
    await expect(fs.readFile(path.join(tmpRoot, 'fresh.ts'), 'utf-8')).resolves.toBe('hello\n');
    if (r.ok) expect(r.value.forcedOverwrite).toBeUndefined();
  });
});
