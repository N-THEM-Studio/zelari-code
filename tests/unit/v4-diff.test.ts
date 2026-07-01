import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  showDiffTool,
  applyDiffTool,
  ShowDiffArgsSchema,
  ApplyDiffArgsSchema,
} from '@zelari/core/harness/tools/builtin/diff';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';

let tmpRoot: string;
let ctx: ToolContext;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-diff-'));
  ctx = { cwd: tmpRoot, signal: undefined as unknown as AbortSignal };
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

/** Parse args through Zod so defaults apply (matches production flow). */
function runShow(rawArgs: Record<string, unknown>) {
  return showDiffTool.execute(ShowDiffArgsSchema.parse(rawArgs), ctx);
}
function runApply(rawArgs: Record<string, unknown>) {
  return applyDiffTool.execute(ApplyDiffArgsSchema.parse(rawArgs), ctx);
}

describe('show_diff (v0.4.0)', () => {
  it('returns empty diff for identical content (unchanged=true)', async () => {
    await fs.writeFile(path.join(tmpRoot, 'f.txt'), 'a\nb\nc\n');
    const r = unwrap(await runShow({
      path: 'f.txt',
      proposedContent: 'a\nb\nc\n',
    }));
    expect(r.unchanged).toBe(true);
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
    expect(r.hunks).toEqual([]);
  });

  it('shows a unified diff for a single-line change', async () => {
    await fs.writeFile(path.join(tmpRoot, 'f.txt'), 'a\nb\nc\n');
    const r = unwrap(await runShow({
      path: 'f.txt',
      proposedContent: 'a\nB\nc\n',
    }));
    expect(r.unchanged).toBe(false);
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
    expect(r.diff).toContain('---');
    expect(r.diff).toContain('+++');
    expect(r.diff).toContain('@@');
    expect(r.diff).toContain('-b');
    expect(r.diff).toContain('+B');
  });

  it('handles multiple non-contiguous hunks', async () => {
    // 14 lines: changes at line 2 (b→B) and line 13 (m→M), distance=11 > 2*CONTEXT=6
    // → splits into 2 distinct hunks
    const file = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\n';
    await fs.writeFile(path.join(tmpRoot, 'f.txt'), file);
    const r = unwrap(await runShow({
      path: 'f.txt',
      proposedContent: 'a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nM\nn\n',
    }));
    expect(r.hunks.length).toBeGreaterThanOrEqual(2);
    expect(r.added).toBe(2);
    expect(r.removed).toBe(2);
  });

  it('treats nonexistent file as empty (creating new)', async () => {
    // Empty file split → ['']. 'hello\n' split → ['hello', '']. LCS matches the
    // trailing empty string as context, so only 'hello' is added.
    const r = unwrap(await runShow({
      path: 'new.txt',
      proposedContent: 'hello\n',
    }));
    expect(r.unchanged).toBe(false);
    expect(r.added).toBe(1); // only 'hello' is new; '' matches context
  });
});

describe('apply_diff (v0.4.0)', () => {
  it('applies a valid hunk and writes file', async () => {
    await fs.writeFile(path.join(tmpRoot, 'f.txt'), 'a\nb\nc\n');
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
    expect(r.hunksApplied).toBe(1);
    expect(r.hunksSkipped).toBe(0);
    const written = await fs.readFile(path.join(tmpRoot, 'f.txt'), 'utf-8');
    expect(written).toBe('a\nB\nc\n');
  });

  it('returns applied=false on context mismatch without writing', async () => {
    await fs.writeFile(path.join(tmpRoot, 'f.txt'), 'a\nb\nc\n');
    const diff = [
      '--- f.txt',
      '+++ f.txt',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-WRONG',
      '+B',
      ' c',
    ].join('\n');
    const r = unwrap(await runApply({ path: 'f.txt', diff }));
    expect(r.applied).toBe(false);
    expect(r.hunksSkipped).toBe(1);
    expect(r.reason).toContain('Delete mismatch');
    // File unchanged
    const written = await fs.readFile(path.join(tmpRoot, 'f.txt'), 'utf-8');
    expect(written).toBe('a\nb\nc\n');
  });

  it('dryRun=true returns success without writing', async () => {
    await fs.writeFile(path.join(tmpRoot, 'f.txt'), 'a\nb\nc\n');
    const diff = [
      '--- f.txt',
      '+++ f.txt',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
    ].join('\n');
    const r = unwrap(await runApply({ path: 'f.txt', diff, dryRun: true }));
    expect(r.applied).toBe(true);
    expect(r.dryRun).toBe(true);
    const written = await fs.readFile(path.join(tmpRoot, 'f.txt'), 'utf-8');
    expect(written).toBe('a\nb\nc\n'); // unchanged
  });

  it('fuzzyMatch=true tolerates whitespace differences', async () => {
    await fs.writeFile(path.join(tmpRoot, 'f.txt'), 'a\nb\nc\n');
    const diff = [
      '--- f.txt',
      '+++ f.txt',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-   b   ',
      '+B',
      ' c',
    ].join('\n');
    const r = unwrap(await runApply({ path: 'f.txt', diff, fuzzyMatch: true }));
    expect(r.applied).toBe(true);
    const written = await fs.readFile(path.join(tmpRoot, 'f.txt'), 'utf-8');
    expect(written).toBe('a\nB\nc\n');
  });

  it('rejects malformed diff (missing headers)', async () => {
    await fs.writeFile(path.join(tmpRoot, 'f.txt'), 'a\n');
    const r = await runApply({
      path: 'f.txt',
      diff: '@@ -1 +1 @@\n-a\n+b',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('missing');
  });

  it('handles missing @@ header gracefully (no hunks)', async () => {
    await fs.writeFile(path.join(tmpRoot, 'f.txt'), 'a\n');
    const r = await runApply({
      path: 'f.txt',
      diff: '--- a\n+++ a\n',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('No hunks');
  });

  it('applies multiple hunks in sequence', async () => {
    await fs.writeFile(path.join(tmpRoot, 'f.txt'), 'a\nb\nc\nd\ne\nf\n');
    const diff = [
      '--- f.txt',
      '+++ f.txt',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      '@@ -4,3 +4,3 @@',
      ' d',
      '-e',
      '+E',
      ' f',
    ].join('\n');
    const r = unwrap(await runApply({ path: 'f.txt', diff }));
    expect(r.applied).toBe(true);
    expect(r.hunksApplied).toBe(2);
    const written = await fs.readFile(path.join(tmpRoot, 'f.txt'), 'utf-8');
    expect(written).toBe('a\nB\nc\nd\nE\nf\n');
  });

  it('creates file if it does not exist (ENOENT treated as empty)', async () => {
    // Empty file is [''] (single empty string). Hunk with no context and only
    // '+' ops adds cleanly: oldStart=1 is fine because we never need to match
    // a context line, just insert at the (empty) position.
    const diff = [
      '--- new.txt',
      '+++ new.txt',
      '@@ -1 +1,2 @@',
      '+hello',
      '+world',
    ].join('\n');
    const r = unwrap(await runApply({ path: 'new.txt', diff }));
    expect(r.applied).toBe(true);
    expect(r.hunksApplied).toBe(1);
    const written = await fs.readFile(path.join(tmpRoot, 'new.txt'), 'utf-8');
    expect(written).toBe('hello\nworld\n');
  });
});