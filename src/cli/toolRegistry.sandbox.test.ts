/**
 * toolRegistry.sandbox.test.ts — v2.16 (HARNESS-10 t26): wrapWithSandbox must
 * run verifyContainment on the WRITE path (write_file / edit_file / apply_diff)
 * as the LAST step before the tool mutates disk, and fail CLOSED with the
 * existing typed sandbox error when containment breaks. Read-side wraps stay
 * resolve-only.
 *
 * Red-if-reopens: the spy test fails if the verify step is dropped from the
 * wrapper again; the junction test fails if the sandbox deny stops being a
 * typed `[sandbox]` error that blocks execution.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import * as sandboxPath from './safety/sandboxPath.js';
import { SandboxViolationError } from './safety/sandboxPath.js';
import { wrapWithSandbox } from './toolRegistry.js';
import { AuditLogger } from './safety/auditLogger.js';
import type { ToolDefinition, ToolPermission, TypedResult } from '@zelari/core/harness/tools/toolTypes';

const IS_WIN = process.platform === 'win32';

/** Win32 junctions need no privileges; POSIX symlinks usually work. */
function canCreateLinks(): boolean {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zelari-t26probe-'));
  try {
    const target = path.join(base, 'target');
    fs.mkdirSync(target);
    const link = path.join(base, 'link');
    if (IS_WIN) fs.symlinkSync(target, link, 'junction');
    else fs.symlinkSync(target, link);
    return fs.statSync(link).isDirectory();
  } catch {
    return false;
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}
const LINKS_OK = canCreateLinks();

function makeTempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Create a link appropriate to the platform. */
function makeLink(target: string, linkPath: string): void {
  if (IS_WIN) fs.symlinkSync(target, linkPath, 'junction');
  else fs.symlinkSync(target, linkPath);
}

/** Minimal recording write tool double (same shape as the built-in write_file). */
function recordingWriteTool(log: string[]): ToolDefinition<{ path: string }, { wrote: string }> {
  return {
    name: 'write_file',
    description: 'test write',
    permissions: [] as ToolPermission[],
    inputSchema: z.object({ path: z.string() }),
    execute: async (input) => {
      log.push(input.path);
      return { ok: true, value: { wrote: input.path } } as TypedResult<{ wrote: string }>;
    },
  };
}

/** Audit double: records entries, never touches disk. */
function recordingAudit(entries: unknown[]): AuditLogger {
  return {
    append: async (entry: unknown) => {
      entries.push(entry);
    },
    runTool: async <T>(params: { fn: () => Promise<T> }): Promise<T> => params.fn(),
  } as unknown as AuditLogger;
}

function makeWrapped(root: string, log: string[], entries: unknown[]) {
  return wrapWithSandbox(recordingWriteTool(log), ['path'], root, recordingAudit(entries), 't26', {
    verifyWrite: true,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('wrapWithSandbox write-path containment (v2.16 t26)', () => {
  it.skipIf(!LINKS_OK)(
    'junction/symlink escape ⇒ typed [sandbox] error, tool NOT executed, audited',
    async () => {
      const root = makeTempRoot('zelari-t26-root-');
      const outside = makeTempRoot('zelari-t26-out-');
      const log: string[] = [];
      const entries: unknown[] = [];
      try {
        fs.mkdirSync(path.join(outside, 'secret'), { recursive: true });
        fs.writeFileSync(path.join(outside, 'secret', 'key.txt'), 'stolen');
        makeLink(outside, path.join(root, 'evil'));

        const wrapped = makeWrapped(root, log, entries);
        const res = await wrapped.execute({ path: 'evil/secret/key.txt' }, {} as never);

        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toContain('[sandbox]');
        expect(log).toEqual([]);
        expect(entries.some((e) => (e as { error?: string }).error === 'sandbox_violation')).toBe(
          true,
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it('legitimate in-workspace path still executes and gets rewritten to the root', async () => {
    const root = makeTempRoot('zelari-t26-ok-');
    const log: string[] = [];
    const entries: unknown[] = [];
    try {
      fs.mkdirSync(path.join(root, 'ok'), { recursive: true });
      const wrapped = makeWrapped(root, log, entries);
      const res = await wrapped.execute({ path: 'ok/file.txt' }, {} as never);

      expect(res.ok).toBe(true);
      expect(log).toEqual([path.join(root, 'ok', 'file.txt')]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('RED-IF-REOPENS: verifyContainment runs pre-write and its violation fails CLOSED', async () => {
    const root = makeTempRoot('zelari-t26-spy-');
    const log: string[] = [];
    const entries: unknown[] = [];
    try {
      fs.mkdirSync(path.join(root, 'd'), { recursive: true });
      const spy = vi
        .spyOn(sandboxPath, 'verifyContainment')
        .mockImplementation((p: string) => {
          throw new SandboxViolationError(
            `Path escapes sandbox root through a symlink/junction: ${p} (simulated mid-flight swap)`,
            p,
            p,
          );
        });

      const wrapped = makeWrapped(root, log, entries);
      const res = await wrapped.execute({ path: 'd/file.txt' }, {} as never);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(path.join(root, 'd', 'file.txt'), { root });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain('[sandbox]');
      expect(log).toEqual([]);
      expect(entries.some((e) => (e as { error?: string }).error === 'sandbox_violation')).toBe(
        true,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('read-side wraps stay resolve-only: verifyContainment NOT invoked', async () => {
    const root = makeTempRoot('zelari-t26-read-');
    const log: string[] = [];
    const entries: unknown[] = [];
    try {
      const spy = vi.spyOn(sandboxPath, 'verifyContainment');
      const wrapped = wrapWithSandbox(
        recordingWriteTool(log),
        ['path'],
        root,
        recordingAudit(entries),
        't26',
      );
      const res = await wrapped.execute({ path: 'file.txt' }, {} as never);

      expect(res.ok).toBe(true);
      expect(spy).not.toHaveBeenCalled();
      expect(log).toEqual([path.join(root, 'file.txt')]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
