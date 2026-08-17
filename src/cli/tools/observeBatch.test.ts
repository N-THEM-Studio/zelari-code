/**
 * observe_batch — tests (2026-07 context-growth plan, Fase 1 acceptance).
 *
 * Covers: aggregation + input order, isolated failures, per-op args
 * validation, schema limits (max ops, dup ids), evidence determinism,
 * evidence/raw modes, aggregate cap with explicit truncation, per-op
 * timeout, Ground Truth batch meta.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import {
  createObserveBatchTool,
  projectEvidence,
  ObserveBatchArgsSchema,
  AGGREGATE_CAP_BYTES,
  MAX_OPERATIONS,
  type ObserveBatchDeps,
  type ObserveBatchResult,
  type ObservationEntry,
} from './observeBatch.js';
import { typedOk, typedErr, type ToolContext, type ToolDefinition } from '@zelari/core/harness/tools/toolTypes';

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type AnyTool = ToolDefinition<any, any>;

// Pin repo root: npm test --workspace=@zelari/core runs with cwd packages/core
// (same as the publish workflow). Do NOT use process.cwd() / path.resolve().
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function fakeCtx(): ToolContext {
  return {
    signal: new AbortController().signal,
    cwd: '/tmp',
    audit: () => {},
    sessionId: 'test',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function okGrepTool(behavior?: (args: Record<string, unknown>) => unknown): AnyTool {
  return {
    name: 'grep_content',
    description: 'fake',
    permissions: ['read'],
    timeoutMs: 5000,
    inputSchema: z.record(z.string(), z.unknown()),
    execute: async (args) => {
      const value = behavior
        ? behavior(args)
        : {
            matches: [
              { relPath: 'src/a.ts', line: 10, text: 'x' },
              { relPath: 'src/b.ts', line: 22, text: 'y' },
            ],
            totalMatches: 2,
            truncated: false,
          };
      return typedOk(value, { status: 'complete', counts: { matches: 2, filesWalked: 7 } });
    },
  };
}

const okReadTool: AnyTool = {
  name: 'read_file',
  description: 'fake',
  permissions: ['read'],
  timeoutMs: 5000,
  inputSchema: z.record(z.string(), z.unknown()),
  execute: async () =>
    typedOk(
      { path: 'src/a.ts', content: 'line1\nline2', totalLines: 120, readLines: { start: 1, end: 2 }, sizeBytes: 4000 },
      { status: 'complete', counts: { lines: 120, bytes: 4000 } },
    ),
};

const okListTool: AnyTool = {
  name: 'list_files',
  description: 'fake',
  permissions: ['read'],
  timeoutMs: 5000,
  inputSchema: z.record(z.string(), z.unknown()),
  execute: async () =>
    typedOk(
      { dir: '/tmp', entries: [{ name: 'src', type: 'directory' }, { name: 'a.ts', type: 'file' }], truncated: false },
      { status: 'complete', counts: { filesWalked: 2 } },
    ),
};

function deps(over: Partial<ObserveBatchDeps['tools']> = {}): ObserveBatchDeps {
  return {
    tools: {
      read_file: okReadTool,
      grep_content: okGrepTool(),
      list_files: okListTool,
      ...over,
    },
  };
}

async function run(depsArg: ObserveBatchDeps, args: unknown) {
  const tool = createObserveBatchTool(depsArg);
  const parsed = tool.inputSchema.parse(args);
  const res = await tool.execute(parsed, fakeCtx());
  expect(res.ok).toBe(true);
  return (res as { ok: true; value: ObserveBatchResult }).value;
}

function stripDynamic(result: ObserveBatchResult): unknown {
  const clone = JSON.parse(JSON.stringify(result));
  for (const o of clone.observations) delete o.durationMs;
  delete clone.totals.wallMs;
  return clone;
}

afterEach(() => {
  delete process.env.ZELARI_OBSERVE_OP_TIMEOUT_MS;
});

describe('observe_batch schema', () => {
  it('rejects more than MAX_OPERATIONS', () => {
    const ops = Array.from({ length: MAX_OPERATIONS + 1 }, (_, i) => ({ id: `op${i}`, tool: 'read_file' }));
    expect(() => ObserveBatchArgsSchema.parse({ operations: ops })).toThrow(/at most/);
  });

  it('rejects duplicate ids', () => {
    expect(() =>
      ObserveBatchArgsSchema.parse({ operations: [{ id: 'a', tool: 'read_file' }, { id: 'a', tool: 'list_files' }] }),
    ).toThrow(/unique/);
  });

  it('defaults resultMode to evidence and args to undefined', () => {
    const parsed = ObserveBatchArgsSchema.parse({ operations: [{ id: 'a', tool: 'read_file' }] });
    expect(parsed.resultMode).toBe('evidence');
  });
});

describe('observe_batch execution', () => {
  it('aggregates independent ops and preserves input order', async () => {
    const slowFirst: AnyTool = {
      ...okGrepTool(),
      execute: async () => {
        await sleep(60);
        return typedOk({ matches: [], totalMatches: 0, truncated: false }, { status: 'complete', counts: { matches: 0 } });
      },
    };
    const result = await run(
      deps({ grep_content: slowFirst }),
      {
        operations: [
          { id: 'first', tool: 'grep_content', args: { pattern: 'x' } },
          { id: 'second', tool: 'read_file', args: { path: 'a.ts' } },
          { id: 'third', tool: 'list_files' },
        ],
      },
    );
    expect(result.failures).toEqual([]);
    expect(result.observations.map((o) => o.id)).toEqual(['first', 'second', 'third']);
    expect(result.totals).toMatchObject({ ops: 3, ok: 3, failed: 0 });
    expect(result.truncated).toBe(false);
  });

  it('isolates per-op failures (typedErr + throw) without failing the batch', async () => {
    const boom: AnyTool = {
      ...okGrepTool(),
      execute: async () => typedErr('boom'),
    };
    const thrower: AnyTool = {
      ...okReadTool,
      execute: async () => {
        throw new Error('kaboom');
      },
    };
    const result = await run(
      deps({ grep_content: boom, read_file: thrower }),
      {
        operations: [
          { id: 'ok', tool: 'list_files' },
          { id: 'err', tool: 'grep_content' },
          { id: 'thr', tool: 'read_file' },
        ],
      },
    );
    expect(result.observations.map((o) => o.id)).toEqual(['ok']);
    const errIds = result.failures.map((f) => f.id).sort();
    expect(errIds).toEqual(['err', 'thr']);
    expect(result.failures.find((f) => f.id === 'err')?.error).toContain('boom');
    expect(result.totals).toMatchObject({ ops: 3, ok: 1, failed: 2 });
  });

  it('validates each op args against the underlying schema (defaults + rejection)', async () => {
    const strict: AnyTool = {
      ...okReadTool,
      inputSchema: z.object({ path: z.string() }),
      execute: async () => typedOk({ path: 'x', content: '', totalLines: 0, readLines: { start: 1, end: 1 }, sizeBytes: 0 }),
    };
    const result = await run(
      deps({ read_file: strict }),
      {
        operations: [
          { id: 'bad', tool: 'read_file', args: {} },
          { id: 'good', tool: 'read_file', args: { path: 'ok.ts' } },
        ],
      },
    );
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error).toMatch(/invalid args.*path/);
    expect(result.observations.map((o) => o.id)).toEqual(['good']);
  });

  it('times out a stuck op (env knob) instead of hanging the batch', async () => {
    process.env.ZELARI_OBSERVE_OP_TIMEOUT_MS = '50';
    const stuck: AnyTool = {
      ...okReadTool,
      execute: async () => {
        await sleep(500);
        return typedOk({ path: 'x', content: '', totalLines: 0, readLines: { start: 1, end: 1 }, sizeBytes: 0 });
      },
    };
    const result = await run(
      deps({ read_file: stuck }),
      { operations: [{ id: 'stuck', tool: 'read_file' }, { id: 'ok', tool: 'list_files' }] },
    );
    expect(result.failures[0]?.error).toMatch(/TIMEOUT after \d+ms/);
    expect(result.observations.map((o) => o.id)).toEqual(['ok']);
  });
});

describe('observe_batch result modes + caps', () => {
  it('evidence mode (default): no raw payload, compact deterministic evidence', async () => {
    const result = await run(
      deps(),
      {
        operations: [
          { id: 'g', tool: 'grep_content', args: { pattern: 'refreshSession' } },
          { id: 'r', tool: 'read_file', args: { path: 'src/a.ts' } },
          { id: 'l', tool: 'list_files' },
        ],
      },
    );
    for (const o of result.observations) {
      expect(o.raw).toBeUndefined();
      expect(o.rawOmitted).toBeUndefined();
      expect(o.bytes).toBeLessThan(400);
    }
    const g = result.observations.find((o) => o.id === 'g');
    expect(g?.evidence).toMatchObject({ tool: 'grep_content', pattern: 'refreshSession', matches: 2, filesWalked: 7 });
    const r = result.observations.find((o) => o.id === 'r');
    expect(r?.evidence).toMatchObject({ tool: 'read_file', path: 'src/a.ts', totalLines: 120 });
    expect(result.totals.bytes).toBeLessThan(1200);
  });

  it('raw mode includes payloads until the aggregate cap, then omits explicitly', async () => {
    const bigPayload = { path: 'big.ts', content: 'x'.repeat(AGGREGATE_CAP_BYTES - 2048), totalLines: 1, readLines: { start: 1, end: 1 }, sizeBytes: AGGREGATE_CAP_BYTES };
    const bigRead: AnyTool = {
      ...okReadTool,
      execute: async () => typedOk(bigPayload, { status: 'complete' }),
    };
    const result = await run(
      deps({ read_file: bigRead }),
      {
        resultMode: 'raw',
        operations: [
          { id: 'first', tool: 'read_file' },
          { id: 'second', tool: 'read_file' },
        ],
      },
    );
    const first = result.observations.find((o) => o.id === 'first');
    const second = result.observations.find((o) => o.id === 'second');
    expect(first?.raw).toBeDefined();
    expect(first?.rawOmitted).toBeUndefined();
    expect(second?.raw).toBeUndefined();
    expect(second?.rawOmitted).toBe(true);
    expect(second?.evidence).toBeDefined();
    expect(result.truncated).toBe(true);
  });

  it('batch meta reflects Ground Truth status (partial on mixed outcome)', async () => {
    const boom: AnyTool = { ...okGrepTool(), execute: async () => typedErr('x') };
    const tool = createObserveBatchTool(deps({ grep_content: boom }));
    const parsed = tool.inputSchema.parse({ operations: [{ id: 'a', tool: 'grep_content' }, { id: 'b', tool: 'list_files' }] });
    const res = await tool.execute(parsed, fakeCtx());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.meta?.status).toBe('partial');
  });
});

describe('observe_batch integration (real registry + real builtins)', () => {
  it('runs real read-only tools through the wrapped registry and projects evidence', async () => {
    const { createBuiltinToolRegistry } = await import('../toolRegistry.js');
    const { registry } = createBuiltinToolRegistry({ lspProvider: null, root: repoRoot });
    expect(registry.list().includes('observe_batch')).toBe(true);

    const toolsDir = path.join(repoRoot, 'src', 'cli', 'tools');
    const pkgJson = path.join(repoRoot, 'package.json');
    const res = await registry.invoke('observe_batch', {
      operations: [
        { id: 'l', tool: 'list_files', args: { path: toolsDir, maxDepth: 1 } },
        {
          id: 'g',
          tool: 'grep_content',
          args: { pattern: 'observe_batch', path: toolsDir, include: ['*.ts'], contextLines: 0, maxMatches: 3 },
        },
        { id: 'r', tool: 'read_file', args: { path: pkgJson, startLine: 1, endLine: 5 } },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const v = res.value as ObserveBatchResult;
    expect(v.failures).toEqual([]);
    expect(v.observations).toHaveLength(3);
    const l = v.observations.find((o) => o.id === 'l');
    expect(l?.evidence).toMatchObject({ tool: 'list_files', entries: expect.any(Number) });
    const sample = (l?.evidence as { sample?: string[] }).sample ?? [];
    expect(sample.length).toBeGreaterThan(0);
    expect(sample.some((n) => n.endsWith('.ts'))).toBe(true);
    const g = v.observations.find((o) => o.id === 'g');
    expect(g?.evidence).toMatchObject({ tool: 'grep_content', pattern: 'observe_batch' });
    expect((g?.evidence as { matches?: number }).matches).toBeGreaterThan(0);
    expect((g?.evidence as { top?: string[] }).top?.[0]).toMatch(/observeBatch(\.test)?\.ts:\d+/);
    const r = v.observations.find((o) => o.id === 'r');
    expect(r?.evidence).toMatchObject({ tool: 'read_file' });
    expect(String((r?.evidence as { path?: string }).path ?? '')).toMatch(/package\.json$/);
    expect(r?.raw).toBeUndefined(); // evidence mode: no payload in context
  });

  it('is registered in readOnly sub-agent registries and disabled by the kill switch', async () => {
    const { createBuiltinToolRegistry } = await import('../toolRegistry.js');
    const ro = createBuiltinToolRegistry({ lspProvider: null, readOnly: true });
    expect(ro.registry.list().includes('observe_batch')).toBe(true);
    process.env.ZELARI_OBSERVE_BATCH = '0';
    try {
      const off = createBuiltinToolRegistry({ lspProvider: null });
      expect(off.registry.list().includes('observe_batch')).toBe(false);
    } finally {
      delete process.env.ZELARI_OBSERVE_BATCH;
    }
  });
});

describe('projectEvidence determinism', () => {
  it('is byte-identical for the same inputs', () => {
    const args = { pattern: 'foo' };
    const value = {
      matches: Array.from({ length: 9 }, (_, i) => ({ relPath: `f${i}.ts`, line: i + 1, text: 'foo' })),
      totalMatches: 9,
      truncated: false,
    };
    const meta = { status: 'partial' as const, counts: { matches: 9, filesWalked: 40 }, truncated: true };
    const a = JSON.stringify(projectEvidence('grep_content', args, value, meta));
    const b = JSON.stringify(projectEvidence('grep_content', args, value, meta));
    expect(a).toBe(b);
    const ev = JSON.parse(a);
    expect(ev.matches).toBe(9);
    expect(ev.filesWalked).toBe(40);
    expect(ev.top).toHaveLength(5);
    expect(ev.top[0]).toBe('f0.ts:1');
  });

  it('two identical batch executions yield identical results modulo timings', async () => {
    const ops = {
      operations: [
        { id: 'g', tool: 'grep_content', args: { pattern: 'p' } },
        { id: 'r', tool: 'read_file', args: { path: 'a' } },
        { id: 'l', tool: 'list_files' },
      ],
    };
    const a = await run(deps(), ops);
    const b = await run(deps(), ops);
    expect(stripDynamic(a)).toEqual(stripDynamic(b));
  });

  it('list_files evidence reports count + sample with dir suffix', () => {
    const ev = projectEvidence('list_files', {}, {
      dir: '/x',
      entries: [
        { name: 'src', type: 'directory' },
        { name: 'a.ts', type: 'file' },
        { name: 'b.ts', type: 'file' },
      ],
      truncated: false,
    });
    expect(ev).toMatchObject({ tool: 'list_files', dir: '/x', entries: 3, sample: ['src/', 'a.ts', 'b.ts'] });
  });
});
