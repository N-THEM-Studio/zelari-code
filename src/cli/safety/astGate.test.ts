/**
 * astGate.test.ts — ADR-0033 (t76): post-write AST gate with auto-revert.
 *
 * Red-if-reopens: a syntax-broken write that SURVIVES on disk fails the
 * revert test; a clean write must never be touched by the gate; the
 * ZELARI_AST_GATE=0 kill switch must restore passthrough behaviour.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileTool } from '@zelari/core/harness/tools/builtin/filesystem';
import { snapshotIdOf } from '@zelari/core/harness/tools/builtin/filesystem';
import { editTool } from '@zelari/core/harness/tools/builtin/edit';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';
import { wrapWithAstGate } from './astGate.js';

let root: string;
let file: string;

const ctx = (): ToolContext => ({
  cwd: root,
  signal: new AbortController().signal,
  audit: () => undefined,
  sessionId: 'ast-gate-test',
});

const gatedEdit = () => wrapWithAstGate(editTool, { root });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-astgate-'));
  file = path.join(root, 'widget.ts');
});

afterEach(async () => {
  delete process.env.ZELARI_AST_GATE;
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

/** Collect process.stderr.write while the given fn runs (loud-skip assertions). */
async function captureStderr(fn: () => Promise<unknown>): Promise<string> {
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await fn();
    return err.mock.calls.map((c) => String(c[0])).join('');
  } finally {
    err.mockRestore();
  }
}

/** Seed the file and return the snapshotId of the seeded content. */
async function seed(content: string): Promise<string> {
  await fs.writeFile(file, content, 'utf8');
  return snapshotIdOf(content);
}

async function readViaTool(): Promise<string> {
  const read = await readFileTool.execute({ path: file, maxBytes: 1_000_000 }, ctx());
  if (!read.ok) throw new Error(read.error);
  return read.value.snapshotId;
}

describe('wrapWithAstGate', () => {
  it('reverts an edit that produces invalid TS and returns a LOUD structured error', async () => {
    const original = 'export const answer = 42;\n';
    const originalSnapshot = await seed(original);
    const snapshotId = await readViaTool();

    const gated = gatedEdit();
    const result = await gated.execute(
      { path: file, oldString: '42', newString: '42 +', snapshotId, replaceAll: false },
      ctx(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('ast_gate_reverted');
    expect(result.error).toMatch(/line \d+, col \d+/);
    const reject = (result.meta as { reject?: Record<string, unknown> } | undefined)?.reject;
    expect(reject?.status).toBe('parse_error');
    expect(String(reject?.path)).toBe(file);
    // ADR-0033 WriteReject schema: minimalDiff + next are the machine contract.
    expect(String(reject?.minimalDiff)).toContain('@@');
    expect(reject?.next).toEqual({ action: 're-read', path: file });
    // The write was CANCELLED: the file is back to its pre-edit bytes.
    await expect(fs.readFile(file, 'utf8')).resolves.toBe(original);
  });

  it('lets a clean edit through untouched (original result, no revert)', async () => {
    await seed('export const answer = 42;\n');
    const snapshotId = await readViaTool();

    const gated = gatedEdit();
    const result = await gated.execute(
      { path: file, oldString: '42', newString: '43', snapshotId, replaceAll: false },
      ctx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toBe(true);
    expect(result.value.occurrencesReplaced).toBe(1);
    await expect(fs.readFile(file, 'utf8')).resolves.toBe('export const answer = 43;\n');
  });

  it('LOUD-skips non-TS/JS extensions (.py write kept, stderr warning, no revert)', async () => {
    const py = path.join(root, 'script.py');
    await fs.writeFile(py, 'def f(:\n  pass\n', 'utf8'); // garbage that TS would reject
    const gated = wrapWithAstGate(
      {
        ...editTool,
        execute: async () => ({ ok: true, value: { path: py } as never }),
      },
      { root },
    );
    let result: Awaited<ReturnType<typeof gated.execute>> | undefined;
    const output = await captureStderr(async () => {
      result = await gated.execute(
        { path: py, oldString: 'x', newString: 'y', snapshotId: '0'.repeat(16), replaceAll: false },
        ctx(),
      );
    });
    // The result still rides through ok — but the skip is ON THE RECORD.
    expect(result?.ok).toBe(true);
    expect(output).toContain('LOUD SKIP (unsupported-extension)');
    await expect(fs.readFile(py, 'utf8')).resolves.toBe('def f(:\n  pass\n');
  });

  it('LOUD-skips when typescript is unavailable (write kept, stderr warning, no revert)', async () => {
    await seed('export const answer = 42;\n');
    const snapshotId = await readViaTool();
    // Fresh astGate module whose dynamic `import('typescript')` rejects —
    // the honest "backend missing" state the gate must announce, not hide.
    vi.resetModules();
    vi.doMock('typescript', () => {
      throw new Error('typescript unavailable');
    });
    try {
      const { wrapWithAstGate: freshGate } = await import('./astGate.js');
      const gated = freshGate(editTool, { root });
      let result: Awaited<ReturnType<typeof gated.execute>> | undefined;
      const output = await captureStderr(async () => {
        result = await gated.execute(
          { path: file, oldString: '42', newString: '42 +', snapshotId, replaceAll: false },
          ctx(),
        );
      });
      expect(result?.ok).toBe(true);
      expect(output).toContain('LOUD SKIP (typescript-unavailable)');
      // No revert: the broken write SURVIVES on disk (with the warning).
      await expect(fs.readFile(file, 'utf8')).resolves.toBe('export const answer = 42 +;\n');
    } finally {
      vi.doUnmock('typescript');
      vi.resetModules();
    }
  });

  it('ZELARI_AST_GATE=0 disables the gate (invalid TS survives, result ok, NO warning)', async () => {
    process.env.ZELARI_AST_GATE = '0';
    await seed('export const answer = 42;\n');
    const snapshotId = await readViaTool();

    const gated = gatedEdit();
    let result: Awaited<ReturnType<typeof gated.execute>> | undefined;
    const output = await captureStderr(async () => {
      result = await gated.execute(
        { path: file, oldString: '42', newString: '42 +', snapshotId, replaceAll: false },
        ctx(),
      );
    });

    expect(result?.ok).toBe(true);
    expect(output).not.toContain('[ast_gate]');
    await expect(fs.readFile(file, 'utf8')).resolves.toBe('export const answer = 42 +;\n');
  });

  it('reverts a write_file-created file by removing it (pre-state was absent)', async () => {
    const { writeFileTool } = await import('@zelari/core/harness/tools/builtin/filesystem');
    const gatedWrite = wrapWithAstGate(writeFileTool, { root });
    const target = path.join(root, 'fresh.ts');

    const result = await gatedWrite.execute(
      { path: target, content: 'export const broken = ;\n', createDirs: false, overwrite: true },
      ctx(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) return;
    expect(result.error).toContain('ast_gate_reverted');
    expect(result.error).toContain('revertedTo=absent');
    const reject = (result.meta as { reject?: Record<string, unknown> } | undefined)?.reject;
    expect(reject?.status).toBe('parse_error');
    await expect(fs.readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
