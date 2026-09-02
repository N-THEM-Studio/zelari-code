/**
 * toolRegistry.anchoredEdit.test.ts — ADR-0033 (t77 + t76) through the REAL
 * CLI registry wiring (sandbox → astGate → diagnostics → permissions).
 *
 * Red-if-reopens:
 * - the default catalog exposes the anchored core `edit` (zod args with
 *   snapshotId/oldString/newString) and NO legacy edit_file/apply_diff;
 * - write_file on an EXISTING file without `overwrite` rejects with the
 *   structured `file_exists` WriteReject and writes nothing; `overwrite:
 *   true` proceeds (write_file on a NEW file never needed the flag);
 * - an edit that breaks TS syntax is auto-reverted with a loud parse_error.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { snapshotIdOf } from '@zelari/core/harness/tools/builtin/filesystem';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';
import { AuditLogger } from './safety/auditLogger.js';
import { createBuiltinToolRegistry } from './toolRegistry.js';

let root: string;

const ctx = (): ToolContext => ({
  cwd: root,
  signal: new AbortController().signal,
  audit: () => undefined,
  sessionId: 'anchored-edit-test',
});

/** Audit double: records entries, never touches disk. */
function recordingAudit(): AuditLogger {
  return {
    append: async () => undefined,
    runTool: async <T>(params: { fn: () => Promise<T> }): Promise<T> => params.fn(),
  } as unknown as AuditLogger;
}

function makeRegistry(opts: { readOnly?: boolean } = {}) {
  return createBuiltinToolRegistry({
    root,
    audit: recordingAudit(),
    sessionId: 'anchored-edit-test',
    diagnostics: false, // hermetic: no external checker spawns in these tests
    lspProvider: null,
    enableTask: false,
    ...(opts.readOnly ? { readOnly: true } : {}),
  });
}

beforeEach(async () => {
  delete process.env.ZELARI_AST_GATE;
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-t77-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('t77 catalog switch (default registry)', () => {
  it('exposes the anchored `edit` + write_file; edit_file/apply_diff are GONE', () => {
    const { registry } = makeRegistry();
    const names = registry.list();

    expect(names).toContain('edit');
    expect(names).toContain('write_file');
    expect(names).toContain('read_file');
    expect(names).not.toContain('edit_file');
    expect(names).not.toContain('apply_diff');
  });

  it('the registered `edit` carries the CORE zod schema (snapshotId-anchored)', () => {
    const { registry } = makeRegistry();
    const edit = registry.get('edit');
    expect(edit).toBeDefined();
    expect(edit?.inputSchema).toBeDefined();

    // Anchored shape parses (snapshotId = 16-hex anchor from read_file).
    const anchored = edit?.inputSchema.safeParse({
      path: path.join(root, 'a.ts'),
      snapshotId: '0123456789abcdef',
      oldString: 'a',
      newString: 'b',
      replaceAll: false,
    });
    expect(anchored?.success).toBe(true);

    // WITHOUT the snapshotId anchor it must NOT parse — the discriminator
    // vs the legacy edit_file schema (oldString/newString, no anchor).
    const unanchored = edit?.inputSchema.safeParse({
      path: path.join(root, 'a.ts'),
      oldString: 'a',
      newString: 'b',
    });
    expect(unanchored?.success).toBe(false);
  });

  it('read-only registries expose no write surface at all', () => {
    const { registry } = makeRegistry({ readOnly: true });
    const names = registry.list();
    expect(names).not.toContain('edit');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('edit_file');
    expect(names).not.toContain('apply_diff');
  });
});

describe('t77 write_file file_exists guard (through the registry)', () => {
  it('write on an EXISTING file without overwrite → file_exists reject, nothing written', async () => {
    const target = path.join(root, 'existing.txt');
    await fs.writeFile(target, 'seed-bytes', 'utf8');
    const wf = makeRegistry().registry.get('write_file');
    expect(wf).toBeDefined();

    // .txt is outside the AST surface: the gate's LOUD SKIP is expected noise.
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const rejected = await wf!.execute(
      { path: target, content: 'clobber', createDirs: false },
      ctx(),
    );

    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error).toContain('FILE_EXISTS');
    const reject = (rejected.meta as { reject?: { status?: string; path?: string } } | undefined)
      ?.reject;
    expect(reject?.status).toBe('file_exists');
    expect(reject?.path).toBe(target);
    // The guard is a GUARD: the on-disk bytes are untouched.
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('seed-bytes');
  });

  it('write on an EXISTING file with overwrite:true → proceeds', async () => {
    const target = path.join(root, 'existing.txt');
    await fs.writeFile(target, 'old', 'utf8');
    const wf = makeRegistry().registry.get('write_file');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const ok = await wf!.execute(
      { path: target, content: 'new', createDirs: false, overwrite: true },
      ctx(),
    );

    expect(ok.ok).toBe(true);
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('new');
  });

  it('write on a NEW file needs no overwrite flag (guard is for existing targets only)', async () => {
    const target = path.join(root, 'fresh.txt');
    const wf = makeRegistry().registry.get('write_file');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const ok = await wf!.execute({ path: target, content: 'x', createDirs: false }, ctx());
    expect(ok.ok).toBe(true);
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('x');
  });
});

describe('t76 AST gate through the registry', () => {
  async function readSnapshot(file: string): Promise<string> {
    const rd = makeRegistry().registry.get('read_file');
    const read = await rd!.execute({ path: file, maxBytes: 1_000_000 }, ctx());
    if (!read.ok) throw new Error(read.error);
    return (read.value as { snapshotId: string }).snapshotId;
  }

  it('a syntax-broken edit is auto-reverted with a LOUD parse_error reject', async () => {
    const file = path.join(root, 'widget.ts');
    const original = 'export const answer = 42;\n';
    await fs.writeFile(file, original, 'utf8');
    const snapshotId = await readSnapshot(file);
    const registry = makeRegistry().registry;

    const result = await registry.get('edit')!.execute(
      { path: file, oldString: '42', newString: '42 +', snapshotId, replaceAll: false },
      ctx(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('ast_gate_reverted');
    expect(result.error).toContain(`revertedTo=${snapshotIdOf(original)}`);
    const reject = (
      result.meta as { reject?: { status?: string; next?: { action: string } } }
    )?.reject;
    expect(reject?.status).toBe('parse_error');
    expect(reject?.next?.action).toBe('re-read');
    // REVERTED: the file is byte-identical to its pre-edit content.
    await expect(fs.readFile(file, 'utf8')).resolves.toBe(original);
  });

  it('a clean anchored edit applies (gate passes it, new snapshotId returned)', async () => {
    const file = path.join(root, 'widget.ts');
    await fs.writeFile(file, 'export const answer = 42;\n', 'utf8');
    const snapshotId = await readSnapshot(file);
    const registry = makeRegistry().registry;

    const result = await registry.get('edit')!.execute(
      { path: file, oldString: '42', newString: '43', snapshotId, replaceAll: false },
      ctx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toBe(true);
    expect(result.value.snapshotId).toBe(snapshotIdOf('export const answer = 43;\n'));
    await expect(fs.readFile(file, 'utf8')).resolves.toBe('export const answer = 43;\n');
  });

  it('a stale snapshotId is rejected BEFORE any write (stale_snapshot, no revert needed)', async () => {
    const file = path.join(root, 'widget.ts');
    await fs.writeFile(file, 'export const answer = 42;\n', 'utf8');
    const registry = makeRegistry().registry;

    const result = await registry.get('edit')!.execute(
      {
        path: file,
        oldString: '42',
        newString: '43',
        snapshotId: 'f'.repeat(16),
        replaceAll: false,
      },
      ctx(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      (result.meta as { reject?: { status?: string } } | undefined)?.reject?.status,
    ).toBe('stale_snapshot');
    await expect(fs.readFile(file, 'utf8')).resolves.toBe('export const answer = 42;\n');
  });
});
