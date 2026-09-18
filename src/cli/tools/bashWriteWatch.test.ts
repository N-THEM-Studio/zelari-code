/**
 * K2.1 / F9 — bash/exec_process writes must land on the spine as synthetic
 * `file.applied` {origin:'bash'} plus radio `bash.write_detected`.
 *
 * Fail-before (the hole): FILE_TOOLS excludes bash, so `echo x > file` via
 * bash leaves the session log with zero `file.applied` events.
 *
 * After the wrap: same command emits origin:'bash'; read-only commands emit
 * nothing; a forced snapshot error is fail-open (tool still runs) and loud
 * (`bash.watch_failed`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createBashTool } from '@zelari/core/harness/tools/builtin/shell';
import { SessionLogWriter, readSessionLog } from '@zelari/core/session';
import type { SessionEventInput } from '@zelari/core/session';
import type { ToolContext, ToolDefinition } from '@zelari/core/harness/tools/toolTypes';
import { createExecProcessTool } from './execProcess.js';
import {
  BASH_WATCH_FAILED,
  BASH_WRITE_DETECTED,
  MAX_EMIT_PATHS,
  snapshotCwd,
  wrapWithBashWriteDetection,
  type BashWriteRadioEvent,
  type FsStatSnap,
} from './bashWriteWatch.js';

let tmpRoot: string;
let writer: SessionLogWriter;
let ctx: ToolContext;
let radio: BashWriteRadioEvent[];

function posixEnd(p: unknown, name: string): boolean {
  return String(p).replace(/\\/g, '/').endsWith(name);
}

describe('K2.1 bash-write detection', () => {
  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-k21-'));
    writer = await SessionLogWriter.open(path.join(tmpRoot, 'session'), 'k21-bash-write', 1);
    radio = [];
    ctx = {
      cwd: tmpRoot,
      signal: new AbortController().signal,
      audit: () => {},
      sessionId: 'k21-bash-write',
      emitSessionEvent: (input: SessionEventInput) => writer.append(input),
    };
  });

  afterEach(async () => {
    await writer.close();
    await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function wrap<I extends Record<string, unknown>, O>(tool: ToolDefinition<I, O>) {
    return wrapWithBashWriteDetection(tool, {
      root: tmpRoot,
      radio: (ev) => {
        radio.push(ev);
      },
    });
  }

  it('bash that writes a file emits file.applied origin:bash + radio bash.write_detected', async () => {
    const tool = wrap(createBashTool());
    const res = await tool.execute(
      { command: 'echo hello > k21.txt', cwd: tmpRoot, timeoutMs: 30_000 },
      ctx,
    );
    expect(res.ok, res.ok ? 'ok' : res.error).toBe(true);
    const report = await readSessionLog(writer.path);
    const applied = report.events.filter((e) => e.kind === 'file.applied');
    expect(applied.length, 'spine was blind to bash writes (F9)').toBeGreaterThanOrEqual(1);
    const hit = applied.find((e) => posixEnd(e.data.path, 'k21.txt'));
    expect(hit, 'expected file.applied for k21.txt').toBeDefined();
    expect(hit?.data.origin).toBe('bash');
    expect(radio.some((r) => r.kind === BASH_WRITE_DETECTED && r.ok === true)).toBe(true);
  });

  it('read-only bash (echo / no redirect) emits no file.applied and no write_detected', async () => {
    const tool = wrap(createBashTool());
    const res = await tool.execute({ command: 'echo hello', cwd: tmpRoot, timeoutMs: 30_000 }, ctx);
    expect(res.ok, res.ok ? 'ok' : res.error).toBe(true);
    const report = await readSessionLog(writer.path);
    expect(report.events.filter((e) => e.kind === 'file.applied')).toEqual([]);
    expect(radio.filter((r) => r.kind === BASH_WRITE_DETECTED)).toEqual([]);
  });

  it('snapshot failure is fail-open: command still runs and radio bash.watch_failed is loud', async () => {
    const dummy: ToolDefinition<Record<string, unknown>, { ran: boolean }> = {
      name: 'bash',
      description: 'dummy',
      permissions: ['execute'],
      inputSchema: z.record(z.string(), z.unknown()),
      execute: async (_input, c) => {
        await fs.writeFile(path.join(c.cwd, 'still-ran.txt'), 'yes');
        return { ok: true, value: { ran: true } };
      },
    };
    const tool = wrapWithBashWriteDetection(dummy, {
      root: tmpRoot,
      snapshot: async () => {
        throw new Error('snap boom');
      },
      radio: (ev) => {
        radio.push(ev);
      },
    });
    const res = await tool.execute({}, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.ran).toBe(true);
    const body = await fs.readFile(path.join(tmpRoot, 'still-ran.txt'), 'utf8');
    expect(body).toBe('yes');
    const report = await readSessionLog(writer.path);
    expect(report.events.filter((e) => e.kind === 'file.applied')).toEqual([]);
    expect(
      radio.some(
        (r) => r.kind === BASH_WATCH_FAILED && r.ok === false && /snap boom/.test(r.detail ?? ''),
      ),
    ).toBe(true);
  });

  it('exec_process write also emits origin:bash', async () => {
    const tool = wrap(createExecProcessTool(tmpRoot));
    const res = await tool.execute(
      {
        program: process.execPath,
        args: ['-e', "require('fs').writeFileSync('from-exec.txt','x')"],
        cwd: tmpRoot,
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    const report = await readSessionLog(writer.path);
    const hit = report.events.find(
      (e) => e.kind === 'file.applied' && posixEnd(e.data.path, 'from-exec.txt'),
    );
    expect(hit).toBeDefined();
    expect(hit?.data.origin).toBe('bash');
  });

  it('skips node_modules/.git/.zelari in the snapshot', async () => {
    await fs.mkdir(path.join(tmpRoot, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, 'node_modules', 'secret.txt'), 'nope');
    await fs.writeFile(path.join(tmpRoot, 'visible.txt'), 'yes');
    const snap = await snapshotCwd(tmpRoot);
    expect([...snap.keys()].some((p) => p.replace(/\\/g, '/').includes('node_modules'))).toBe(false);
    expect([...snap.keys()].some((p) => posixEnd(p, 'visible.txt'))).toBe(true);
  });

  it('caps spine emit at MAX_EMIT_PATHS and marks radio truncated', async () => {
    const dummy: ToolDefinition<Record<string, unknown>, { ran: boolean }> = {
      name: 'bash',
      description: 'dummy',
      permissions: ['execute'],
      inputSchema: z.record(z.string(), z.unknown()),
      execute: async () => ({ ok: true, value: { ran: true } }),
    };
    const pre: FsStatSnap = new Map();
    const post: FsStatSnap = new Map();
    for (let i = 0; i < MAX_EMIT_PATHS + 5; i += 1) {
      post.set(`f-${i}.txt`, { size: 1, mtimeMs: 1 });
    }
    let calls = 0;
    const tool = wrapWithBashWriteDetection(dummy, {
      root: tmpRoot,
      snapshot: async () => {
        calls += 1;
        return calls === 1 ? pre : post;
      },
      radio: (ev) => {
        radio.push(ev);
      },
    });
    const res = await tool.execute({}, ctx);
    expect(res.ok).toBe(true);
    const report = await readSessionLog(writer.path);
    expect(report.events.filter((e) => e.kind === 'file.applied')).toHaveLength(MAX_EMIT_PATHS);
    const hit = radio.find((r) => r.kind === BASH_WRITE_DETECTED);
    expect(hit?.truncated).toBe(true);
    expect(hit?.count).toBe(MAX_EMIT_PATHS + 5);
  });
});
