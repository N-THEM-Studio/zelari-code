import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createTaskTool,
  buildTaskUserPrompt,
  buildTaskAutoVerifyPrompt,
  maxTaskSpawnsPerTurn,
  outcomeMemoryAllowed,
  runAutoVerifyAfterGeneral,
  runSubAgent,
  runTentacle,
  resetTaskVerifyObligation,
  seedTaskVerifyObligation,
  taskVerifyObligation,
  TASK_TOOL_TIMEOUT_MS,
  type SubAgentContext,
  type SubAgentHarness,
  type TaskToolDeps,
  type TentacleSuccess,
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
  it('gives general writers a 45-minute wrapper budget', () => {
    const tool = createTaskTool({ createSubAgentContext: async () => null });
    expect(tool.timeoutMs).toBe(TASK_TOOL_TIMEOUT_MS);
    expect(TASK_TOOL_TIMEOUT_MS).toBe(2_700_000);
  });

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

  it('passes agent kind to createSubAgentContext (t78: writer is followed by the auto-verify)', async () => {
    const seen: string[] = [];
    const tool = createTaskTool({
      createSubAgentContext: async ({ agent }) => {
        seen.push(agent);
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
    expect(seen[0]).toBe('general');
    // t78: the runtime general⇒verify obligation spawns a verify after the
    // writer — the last sub-agent context built for a general task is verify.
    expect(seen[seen.length - 1]).toBe('verify');
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


describe('runSubAgent abort', () => {
  it('calls harness.cancel when the parent signal aborts mid-run', async () => {
    let cancelled = false;
    const harness: SubAgentHarness = {
      async *run() {
        yield { type: 'message_start' } as BrainEvent;
        await new Promise((r) => setTimeout(r, 200));
        yield { type: 'message_delta', delta: 'late' } as unknown as BrainEvent;
        yield { type: 'message_end' } as BrainEvent;
      },
      cancel() {
        cancelled = true;
      },
    };
    const ac = new AbortController();
    const p = runSubAgent(harness, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    const res = await p;
    expect(cancelled).toBe(true);
    expect(res.aborted).toBe(true);
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

/**
 * t78 (ADR-0033 slice): the runtime general⇒verify chain the `task` tool
 * runs after a successful general. These unit tests call the exported chain
 * directly so the cwd-inheritance contract (same worktree while it exists,
 * parent tree once it is gone) is pinned without needing a real git repo.
 */
describe('runAutoVerifyAfterGeneral (t78)', () => {
  let prevRounds: string | undefined;

  beforeEach(() => {
    resetTaskVerifyObligation();
    prevRounds = process.env.ZELARI_KRAKEN_MAX_REVIEW_ROUNDS;
    delete process.env.ZELARI_KRAKEN_MAX_REVIEW_ROUNDS;
  });

  afterEach(() => {
    if (prevRounds === undefined) delete process.env.ZELARI_KRAKEN_MAX_REVIEW_ROUNDS;
    else process.env.ZELARI_KRAKEN_MAX_REVIEW_ROUNDS = prevRounds;
    resetTaskVerifyObligation();
  });

  function fakeGeneral(worktreePath: string | null): TentacleSuccess {
    return {
      ok: true,
      agent: 'general',
      thoroughness: 'medium',
      model: 'm',
      result: 'did the work',
      footer: '',
      worktreePath,
      worktreeHandle: null,
    };
  }

  function chainDeps(conclusions: string[], seenCwds: string[]) {
    return {
      createSubAgentContext: async ({ cwd }: { cwd: string }) => {
        seenCwds.push(cwd);
        return { ...dummyContext, cwd };
      },
      harnessFactory: () =>
        fakeHarness([
          { type: 'message_start' },
          { type: 'message_delta', delta: conclusions.shift() ?? '' } as Partial<BrainEvent>,
          { type: 'message_end' },
        ]),
    };
  }

  it('verifies inside an EXISTING worktree path (same tree the writer used)', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'zelari-t78-wt-'));
    try {
      const seenCwds: string[] = [];
      const deps = chainDeps(['clean\nVERDICT: PASS'], seenCwds);
      const summary = await runAutoVerifyAfterGeneral({
        deps,
        original: { description: 'fix foo', prompt: 'edit foo', acceptance: ['tests pass'] },
        general: fakeGeneral(root),
        parentCwd: path.join(root, 'parent'),
        sessionId: 't78-wt',
      });
      // The verify ran in the still-existing worktree, not the parent tree.
      expect(seenCwds[0]).toBe(root);
      expect(summary).toContain('verify PASS');
      expect(taskVerifyObligation()).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the parent tree when the worktree was merged and cleaned up', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'zelari-t78-merged-'));
    try {
      const seenCwds: string[] = [];
      const deps = chainDeps(['clean\nVERDICT: PASS'], seenCwds);
      const summary = await runAutoVerifyAfterGeneral({
        deps,
        original: { description: 'fix foo', prompt: 'edit foo' },
        general: fakeGeneral(path.join(root, 'vanished-worktree')),
        parentCwd: root,
        sessionId: 't78-merged',
      });
      // The worktree path no longer exists — the work was auto-merged into
      // the parent tree, which is what must be verified.
      expect(seenCwds[0]).toBe(root);
      expect(summary).toContain('verify PASS');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reworks on FAIL in the SAME tree, then verifies again', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'zelari-t78-chain-'));
    try {
      const seenCwds: string[] = [];
      const deps = chainDeps(
        // verify FAIL → rework conclusion → fresh verify PASS.
        ['wrong\nVERDICT: FAIL', 'redid the work', 'clean now\nVERDICT: PASS'],
        seenCwds,
      );
      const summary = await runAutoVerifyAfterGeneral({
        deps,
        original: { description: 'fix foo', prompt: 'edit foo' },
        general: fakeGeneral(root),
        parentCwd: root,
        sessionId: 't78-chain',
      });
      // verify → rework → fresh verify, all inside the same tree.
      expect(seenCwds).toEqual([root, root, root]);
      expect(summary).toContain('verify PASS');
      expect(taskVerifyObligation()).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('emits agent_status completed on the general row when verify PASSes (t94 terminal)', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'zelari-t78-status-'));
    try {
      const seenCwds: string[] = [];
      const events: BrainEvent[] = [];
      const deps = {
        ...chainDeps(['clean\nVERDICT: PASS'], seenCwds),
        onTentacleEvent: (ev: BrainEvent) => events.push(ev),
      };
      const summary = await runAutoVerifyAfterGeneral({
        deps,
        original: { description: 'fix foo', prompt: 'edit foo' },
        general: { ...fakeGeneral(root), agentId: 'gen-1' },
        parentCwd: root,
        sessionId: 't78-status',
      });
      expect(summary).toContain('verify PASS');
      const phases = events
        .filter((e) => e.type === 'agent_status' && e.agentId === 'gen-1')
        .map((e) => e as unknown as Record<string, unknown>);
      expect(phases.map((p) => p.message)).toEqual(['verifying…', 'verify PASS']);
      expect(phases[0].status).toBe('running');
      expect(phases[1].status).toBe('completed');
      expect(phases.every((p) => p.agentId === 'gen-1')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('emits agent_status failed when a rework round cannot run (row must not stay running)', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'zelari-t78-reworkfail-'));
    try {
      const events: BrainEvent[] = [];
      let calls = 0;
      const deps = {
        // First call is the verify tentacle (FAILs); the rework reuses the
        // same tree and cannot run → the chain must caption the row failed.
        createSubAgentContext: async ({ cwd }: { cwd: string }) => {
          calls += 1;
          return calls === 1 ? { ...dummyContext, cwd } : null;
        },
        harnessFactory: () =>
          fakeHarness([
            { type: 'message_start' },
            { type: 'message_delta', delta: 'wrong\nVERDICT: FAIL' } as Partial<BrainEvent>,
            { type: 'message_end' },
          ]),
        onTentacleEvent: (ev: BrainEvent) => events.push(ev),
      };
      const summary = await runAutoVerifyAfterGeneral({
        deps,
        original: { description: 'fix foo', prompt: 'edit foo' },
        general: { ...fakeGeneral(root), agentId: 'gen-2' },
        parentCwd: root,
        sessionId: 't78-reworkfail',
      });
      expect(summary).toContain('rework round 1 failed');
      const phases = events
        .filter((e) => e.type === 'agent_status' && e.agentId === 'gen-2')
        .map((e) => e as unknown as Record<string, unknown>);
      expect(phases.map((p) => p.message)).toEqual(['verifying…', 'rework round 1 failed']);
      expect(phases[1].status).toBe('failed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('buildTaskAutoVerifyPrompt (t78)', () => {
  it('restates the task, scope and acceptance and requires the parseable trailer', () => {
    const prompt = buildTaskAutoVerifyPrompt({
      description: 'fix foo',
      prompt: 'edit foo',
      scope: ['src/foo.ts'],
      acceptance: ['tests pass', 'typecheck clean'],
    });
    expect(prompt).toContain('fix foo');
    expect(prompt).toContain('edit foo');
    expect(prompt).toContain('src/foo.ts');
    expect(prompt).toContain('tests pass');
    expect(prompt).toContain('typecheck clean');
    expect(prompt).toContain('VERDICT: PASS');
    expect(prompt).toContain('VERDICT: FAIL');
  });
});

describe('blind verify input (F3.2)', () => {
  it('carries goal + scope + acceptance and no general result marker', () => {
    const original = {
      description: 'fix foo',
      prompt: 'edit foo',
      scope: ['src/foo.ts'],
      acceptance: ['npm test → exit 0', 'typecheck clean'],
    };
    // runTentacle builds the verify user payload from the ORIGINAL contract
    // alone: buildTaskAutoVerifyPrompt prepended, scope + acceptance appended.
    const payload = buildTaskUserPrompt({
      prompt: buildTaskAutoVerifyPrompt(original),
      scope: original.scope,
      acceptance: original.acceptance,
    });
    expect(payload).toContain('npm test → exit 0');
    expect(payload).toContain('typecheck clean');
    expect(payload).toContain('src/foo.ts');
    // The implementer's self-report never reaches the verifier.
    expect(payload).not.toContain('[sub-agent:general');
    expect(payload).not.toContain('## Context from completed upstream tasks');
  });

  it('instructs the verifier to run the commands itself and trust no claim', () => {
    const prompt = buildTaskAutoVerifyPrompt({ description: 'fix foo', prompt: 'edit foo' });
    expect(prompt).toMatch(/BLIND/i);
    expect(prompt).toMatch(/run the acceptance commands yourself/i);
  });
});

describe('outcomeMemoryAllowed (F3.3)', () => {
  afterEach(() => resetTaskVerifyObligation());

  it('is false while a general⇒verify obligation is open, true when none is pending', () => {
    resetTaskVerifyObligation();
    expect(outcomeMemoryAllowed()).toBe(true);
    seedTaskVerifyObligation({ description: 'fix foo', detail: 'verify FAIL unresolved' });
    expect(outcomeMemoryAllowed()).toBe(false);
    resetTaskVerifyObligation();
    expect(outcomeMemoryAllowed()).toBe(true);
  });
});

describe('memory only on PASS (F3.3)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'zelari-f33-'));
    resetTaskVerifyObligation();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    resetTaskVerifyObligation();
  });

  function recordingMemory(): { calls: Array<Record<string, unknown>>; memory: TaskToolDeps['memoryService'] } {
    const calls: Array<Record<string, unknown>> = [];
    const memory = {
      remember: async (input: Record<string, unknown>) => {
        calls.push(input);
        return { id: `mem-${calls.length}` };
      },
    } as unknown as TaskToolDeps['memoryService'];
    return { calls, memory };
  }

  function tentacleDeps(conclusion: string): TaskToolDeps {
    return {
      createSubAgentContext: async ({ cwd }: { cwd: string }) => ({ ...dummyContext, cwd }),
      harnessFactory: () =>
        fakeHarness([
          { type: 'message_start' },
          { type: 'message_delta', delta: conclusion } as Partial<BrainEvent>,
          { type: 'message_end' },
        ]),
      allowWorktree: false,
    };
  }

  it('writes a verification memory for a verify PASS', async () => {
    const { calls, memory } = recordingMemory();
    const res = await runTentacle({
      deps: { ...tentacleDeps('clean\nVERDICT: PASS'), memoryService: memory, memoryAutoWrite: true },
      args: { description: 'verify x', prompt: 'p' },
      agent: 'verify',
      thoroughness: 'quick',
      parentCwd: root,
      sessionId: 'f33',
    });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('verification');
    expect(calls[0].confidence).toBe(0.98);
  });

  it('writes NO memory for a verify that did not PASS', async () => {
    const { calls, memory } = recordingMemory();
    await runTentacle({
      deps: { ...tentacleDeps('wrong\nVERDICT: FAIL'), memoryService: memory, memoryAutoWrite: true },
      args: { description: 'verify x', prompt: 'p' },
      agent: 'verify',
      thoroughness: 'quick',
      parentCwd: root,
      sessionId: 'f33',
    });
    expect(calls).toHaveLength(0);
  });

  it('never writes a general outcome in runTentacle (deferred to the verified chain)', async () => {
    const { calls, memory } = recordingMemory();
    await runTentacle({
      deps: { ...tentacleDeps('did the work'), memoryService: memory, memoryAutoWrite: true },
      args: { description: 'edit foo', prompt: 'p' },
      agent: 'general',
      thoroughness: 'quick',
      parentCwd: root,
      sessionId: 'f33',
    });
    expect(calls).toHaveLength(0);
  });

  /** Local chain helpers (mirror the t78 block, kept self-contained here). */
  function fakeGeneral(worktreePath: string | null): TentacleSuccess {
    return {
      ok: true,
      agent: 'general',
      thoroughness: 'medium',
      model: 'm',
      result: 'did the work',
      footer: '',
      worktreePath,
      worktreeHandle: null,
    };
  }

  function chainDeps(conclusions: string[]): TaskToolDeps {
    return {
      createSubAgentContext: async ({ cwd }: { cwd: string }) => ({ ...dummyContext, cwd }),
      harnessFactory: () =>
        fakeHarness([
          { type: 'message_start' },
          { type: 'message_delta', delta: conclusions.shift() ?? '' } as Partial<BrainEvent>,
          { type: 'message_end' },
        ]),
    };
  }

  async function runChain(conclusions: string[]) {
    const rec = recordingMemory();
    const deps: TaskToolDeps = {
      ...chainDeps(conclusions),
      memoryService: rec.memory,
      memoryAutoWrite: true,
    };
    await runAutoVerifyAfterGeneral({
      deps,
      original: { description: 'fix foo', prompt: 'edit foo', acceptance: ['tests pass'] },
      general: fakeGeneral(root),
      parentCwd: root,
      sessionId: 'f33-chain',
    });
    return rec.calls;
  }

  it('writes the general outcome from the auto-verify chain ONLY on PASS', async () => {
    const passCalls = await runChain(['clean\nVERDICT: PASS']);
    const outcome = passCalls.find((c) => c.kind === 'outcome');
    expect(outcome).toBeDefined();
    expect(outcome?.confidence).toBe(0.98);
    expect((outcome?.metadata as Record<string, unknown> | undefined)?.verified).toBe(true);
  });

  it('writes NO general outcome on FAIL', async () => {
    const calls = await runChain(['wrong\nVERDICT: FAIL']);
    expect(calls.filter((c) => c.kind === 'outcome')).toHaveLength(0);
  });

  it('writes NO general outcome on an unknown verdict', async () => {
    const calls = await runChain(['I could not determine the outcome']);
    expect(calls.filter((c) => c.kind === 'outcome')).toHaveLength(0);
  });
});
