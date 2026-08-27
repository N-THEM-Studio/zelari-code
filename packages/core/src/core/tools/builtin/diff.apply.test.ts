import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyDiffTool, ApplyDiffArgsSchema } from './diff.js';
import type { ToolContext } from '../toolTypes.js';

let tmpRoot: string;
let ctx: ToolContext;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-apply-'));
  ctx = {
    cwd: tmpRoot,
    signal: new AbortController().signal,
    audit: () => {},
    sessionId: 'test-apply',
  };
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function unwrap<T>(result: { ok: boolean; value?: T; error?: { message: string } | string }): T {
  if (!result.ok) {
    const err = typeof result.error === 'string' ? result.error : result.error?.message;
    throw new Error(`tool failed: ${err}`);
  }
  return result.value as T;
}

function runApply(rawArgs: Record<string, unknown>) {
  return applyDiffTool.execute(ApplyDiffArgsSchema.parse(rawArgs), ctx);
}

describe('apply_diff CRLF + hunk offset', () => {
  it('applies an LF diff to a CRLF file and preserves CRLF', async () => {
    await fs.writeFile(path.join(tmpRoot, 'f.txt'), 'a\r\nb\r\nc\r\n', 'utf-8');
    const diff = [
      '--- f.txt',
      '+++ f.txt',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
    ].join('\n');
    const r = unwrap(await runApply({ path: 'f.txt', diff }));
    expect(r.applied).toBe(true);
    const written = await fs.readFile(path.join(tmpRoot, 'f.txt'), 'utf-8');
    expect(written).toBe('a\r\nB\r\nc\r\n');
  });

  it('relocates a later hunk whose @@ offset drifted after an insert', async () => {
    await fs.writeFile(path.join(tmpRoot, 'f.txt'), 'a\nb\nc\nd\ne\nf\n');
    const diff = [
      '--- f.txt',
      '+++ f.txt',
      '@@ -1,3 +1,4 @@',
      ' a',
      ' b',
      '+X',
      ' c',
      '@@ -6,2 +7,2 @@',
      ' e',
      '-f',
      '+F',
    ].join('\n');
    const r = unwrap(await runApply({ path: 'f.txt', diff }));
    expect(r.applied).toBe(true);
    expect(r.hunksApplied).toBe(2);
    const written = await fs.readFile(path.join(tmpRoot, 'f.txt'), 'utf-8');
    expect(written).toBe('a\nb\nX\nc\nd\ne\nF\n');
  });

  it('refuses to guess when a drifted hunk matches two equally close sites', async () => {
    await fs.writeFile(path.join(tmpRoot, 'f.txt'), 'foo\nbar\nx\ny\nfoo\nbar\n');
    const diff = [
      '--- f.txt',
      '+++ f.txt',
      '@@ -3,2 +3,2 @@',
      ' foo',
      '-bar',
      '+BAR',
    ].join('\n');
    const r = unwrap(await runApply({ path: 'f.txt', diff }));
    expect(r.applied).toBe(false);
    expect(r.reason).toMatch(/Ambiguous hunk/i);
    const written = await fs.readFile(path.join(tmpRoot, 'f.txt'), 'utf-8');
    expect(written).toBe('foo\nbar\nx\ny\nfoo\nbar\n');
  });
});
