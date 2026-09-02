import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyDiffTool, ApplyDiffArgsSchema } from './diff.js';
import { WriteRejectSchema } from './edit.js';
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

  it('rejects (hunk_mismatch) a later hunk whose @@ offset drifted — zero relocation, atomic', async () => {
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
    // oldStart 6 declares the position AFTER the insert shifted it: the declared
    // position no longer holds 'e' → reject, never search for 'e' elsewhere.
    const res = await runApply({ path: 'f.txt', diff });
    expect(res.ok).toBe(true); // envelope stays ok; applied:false carries the reject
    if (!res.ok) return;
    expect(res.value.applied).toBe(false);
    expect(res.value.hunksApplied).toBe(1);
    expect(res.value.hunksSkipped).toBe(1);
    const reject = WriteRejectSchema.parse(res.meta?.reject);
    expect(reject.status).toBe('hunk_mismatch');
    expect(reject.minimalDiff).toContain('@@ -6,2 +7,2 @@'); // failed hunk + context
    expect(reject.span).toEqual({ startLine: 5, endLine: 7 });
    expect(reject.next.action).toBe('re-read');
    const written = await fs.readFile(path.join(tmpRoot, 'f.txt'), 'utf-8');
    expect(written).toBe('a\nb\nc\nd\ne\nf\n'); // atomic: hunk 1 is NOT written either
  });

  it('rejects a hunk whose context exists elsewhere — fuzzyMatch must not enable relocation', async () => {
    await fs.writeFile(path.join(tmpRoot, 'f.txt'), 'foo\nbar\nx\ny\nfoo\nbar\n');
    const diff = [
      '--- f.txt',
      '+++ f.txt',
      '@@ -3,2 +3,2 @@',
      ' foo',
      '-bar',
      '+BAR',
    ].join('\n');
    // 'foo/bar' exists at lines 1-2 and 5-6, but the hunk DECLARES line 3 ('x').
    // The old engine relocated to the nearest match; now it must refuse.
    const res = await runApply({ path: 'f.txt', diff, fuzzyMatch: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.applied).toBe(false);
    expect(res.value.hunksApplied).toBe(0);
    expect(res.value.hunksSkipped).toBe(1);
    expect(res.value.reason).toMatch(/Mismatch at line 3/);
    const reject = WriteRejectSchema.parse(res.meta?.reject);
    expect(reject.status).toBe('hunk_mismatch');
    expect(reject.minimalDiff).toContain('@@ -3,2 +3,2 @@'); // failed hunk + its context
    expect(reject.minimalDiff).toContain('-bar');
    const written = await fs.readFile(path.join(tmpRoot, 'f.txt'), 'utf-8');
    expect(written).toBe('foo\nbar\nx\ny\nfoo\nbar\n');
  });

  it('fuzzyMatch still tolerates whitespace AT the declared position', async () => {
    await fs.writeFile(path.join(tmpRoot, 'f.txt'), 'a  \nb\n');
    const diff = [
      '--- f.txt',
      '+++ f.txt',
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '+B',
    ].join('\n');
    const r = unwrap(await runApply({ path: 'f.txt', diff, fuzzyMatch: true }));
    expect(r.applied).toBe(true);
    expect(r.hunksApplied).toBe(1);
    const written = await fs.readFile(path.join(tmpRoot, 'f.txt'), 'utf-8');
    expect(written).toBe('a  \nB\n'); // context line keeps the file's bytes
  });
});
