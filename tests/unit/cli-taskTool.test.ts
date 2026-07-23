import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createTaskTool,
  buildTaskUserPrompt,
  maxTaskSpawnsPerTurn,
  type SubAgentContext,
  type SubAgentHarness,
} from '../../src/cli/tools/taskTool.js';
import { createBuiltinToolRegistry } from '../../src/cli/toolRegistry.js';
import type { BrainEvent } from '@zelari/core/shared/events';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';

const ctx: ToolContext = {
  signal: new AbortController().signal,
  cwd: process.cwd(),
  audit: () => {},
  sessionId: 'test',
};

/** Fake harness that replays a fixed event sequence. */
function fakeHarness(events: Array<Partial<BrainEvent>>): SubAgentHarness {
  return {
    async *run() {
      for (const e of events) yield e as BrainEvent;
    },
  };
}

/** Minimal non-null sub-agent context (unused by the fake harness). */
const dummyContext: SubAgentContext = {
  providerStream: (async function* () {})() as never,
  model: 'm',
  provider: 'openai-compatible',
  registry: {} as never,
  tools: [],
};

describe('createTaskTool', () => {
  it('validates that description + prompt are required', () => {
    const tool = createTaskTool({ createSubAgentContext: async () => null });
    expect(tool.name).toBe('task');
    expect(tool.inputSchema.safeParse({ description: 'x' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ description: 'find X', prompt: 'do it' }).success).toBe(true);
    expect(
      tool.inputSchema.safeParse({
        description: 'find X',
        prompt: 'do it',
        agent: 'explore',
        thoroughness: 'quick',
      }).success,
    ).toBe(true);
  });

  it('returns an error when no provider is configured', async () => {
    const tool = createTaskTool({ createSubAgentContext: async () => null });
    const res = await tool.execute({ description: 'x', prompt: 'p' }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no provider/i);
  });

  it('returns the sub-agent final message as the result', async () => {
    const tool = createTaskTool({
      createSubAgentContext: async () => dummyContext,
      harnessFactory: () =>
        fakeHarness([
          { type: 'message_start' },
          { type: 'message_delta', delta: 'The handler lives in ' } as Partial<BrainEvent>,
          { type: 'message_delta', delta: 'src/foo.ts:42.' } as Partial<BrainEvent>,
          { type: 'message_end' },
        ]),
    });
    const res = await tool.execute({ description: 'locate handler', prompt: 'where is X?' }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.result).toContain('The handler lives in src/foo.ts:42.');
      expect(res.value.agent).toBe('explore');
    }
  });

  it('passes agent kind to createSubAgentContext', async () => {
    let seen: string | undefined;
    const tool = createTaskTool({
      createSubAgentContext: async ({ agent }) => {
        seen = agent;
        return dummyContext;
      },
      harnessFactory: () =>
        fakeHarness([
          { type: 'message_start' },
          { type: 'message_delta', delta: 'ok' } as Partial<BrainEvent>,
          { type: 'message_end' },
        ]),
    });
    await tool.execute(
      { description: 'edit', prompt: 'fix x', agent: 'general', thoroughness: 'deep' },
      ctx,
    );
    expect(seen).toBe('general');
  });

  it('returns the LAST completed message (tool-call turns discarded)', async () => {
    const tool = createTaskTool({
      createSubAgentContext: async () => dummyContext,
      harnessFactory: () =>
        fakeHarness([
          { type: 'message_start' },
          { type: 'message_delta', delta: 'let me look…' } as Partial<BrainEvent>,
          { type: 'message_end' },
          { type: 'message_start' },
          { type: 'message_delta', delta: 'Final: use bar().' } as Partial<BrainEvent>,
          { type: 'message_end' },
        ]),
    });
    const res = await tool.execute({ description: 'x', prompt: 'p' }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.result).toContain('Final: use bar().');
  });

  it('errors when the sub-agent produces no output', async () => {
    const tool = createTaskTool({
      createSubAgentContext: async () => dummyContext,
      harnessFactory: () => fakeHarness([{ type: 'message_start' }, { type: 'message_end' }]),
    });
    const res = await tool.execute({ description: 'x', prompt: 'p' }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no output/i);
  });
});

describe('createBuiltinToolRegistry — task tool + readOnly isolation', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'task-reg-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('full registry advertises the task tool alongside the edit tools', () => {
    const { registry, tools } = createBuiltinToolRegistry({ root });
    const names = tools.map((t) => t.name);
    expect(names).toContain('task');
    expect(names).toContain('write_file');
    expect(names).toContain('skill');
    expect(registry.get('task')).toBeDefined();
  });

  it('read-only registry omits task + all mutating tools (no recursion, no writes)', () => {
    const { registry, tools } = createBuiltinToolRegistry({ root, readOnly: true });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('task');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('edit_file');
    expect(names).not.toContain('apply_diff');
    expect(names).not.toContain('bash');
    expect(names).not.toContain('skill');
    // Observe tools remain.
    expect(names).toContain('read_file');
    expect(names).toContain('grep_content');
    expect(registry.get('task')).toBeUndefined();
    expect(registry.get('write_file')).toBeUndefined();
  });

  it('verify profile has bash but no writes/task', () => {
    const { tools } = createBuiltinToolRegistry({ root, profile: 'verify' });
    const names = tools.map((t) => t.name);
    expect(names).toContain('bash');
    expect(names).toContain('read_file');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('task');
  });

  it('general profile has writes but no nested task', () => {
    const { tools } = createBuiltinToolRegistry({ root, profile: 'general' });
    const names = tools.map((t) => t.name);
    expect(names).toContain('write_file');
    expect(names).not.toContain('task');
  });

  it('respects enableTask:false in the full registry', () => {
    const { tools } = createBuiltinToolRegistry({ root, enableTask: false });
    expect(tools.map((t) => t.name)).not.toContain('task');
  });
});


describe('Kraken task contract helpers', () => {
  it('buildTaskUserPrompt appends scope and acceptance', () => {
    const text = buildTaskUserPrompt({
      prompt: 'Fix the parser',
      scope: ['src/parser.ts'],
      acceptance: ['typecheck passes'],
    });
    expect(text).toContain('Fix the parser');
    expect(text).toMatch(/## Scope/);
    expect(text).toContain('src/parser.ts');
    expect(text).toMatch(/## Acceptance/);
    expect(text).toContain('typecheck passes');
  });

  it('maxTaskSpawnsPerTurn defaults to 6 and honors env', () => {
    const prev = process.env.ZELARI_KRAKEN_MAX_TASK_SPAWNS;
    delete process.env.ZELARI_KRAKEN_MAX_TASK_SPAWNS;
    expect(maxTaskSpawnsPerTurn()).toBe(6);
    process.env.ZELARI_KRAKEN_MAX_TASK_SPAWNS = '3';
    expect(maxTaskSpawnsPerTurn()).toBe(3);
    if (prev === undefined) delete process.env.ZELARI_KRAKEN_MAX_TASK_SPAWNS;
    else process.env.ZELARI_KRAKEN_MAX_TASK_SPAWNS = prev;
  });

  it('accepts scope + acceptance in schema', () => {
    const tool = createTaskTool({ createSubAgentContext: async () => null });
    expect(
      tool.inputSchema.safeParse({
        description: 'slice',
        prompt: 'do it',
        scope: ['src/a.ts'],
        acceptance: ['tests green'],
      }).success,
    ).toBe(true);
  });
});
