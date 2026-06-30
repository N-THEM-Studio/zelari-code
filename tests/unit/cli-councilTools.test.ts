import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { dispatchCouncil } from '../../src/cli/councilDispatcher.js';
import { runCouncilPure } from '../../src/agents/councilApi.js';
import { ToolRegistry } from '../../src/main/core/tools/registry.js';
import { typedOk, typedErr, type ToolDefinition } from '../../src/main/core/tools/toolTypes.js';
import type { ProviderStreamFn } from '../../src/main/core/AgentHarness.js';
import type { BrainEvent } from '../../src/shared/events.js';

/** Drain an async iterable into an array. */
async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/** Build a registry with echo (success) + always_fail (error) + throwing (throws). */
function buildMixedRegistry(): {
  registry: ToolRegistry;
  echoCalls: Array<{ text: string }>;
  failCount: { value: number };
} {
  const echoCalls: Array<{ text: string }> = [];
  const failCount = { value: 0 };

  const echo: ToolDefinition<{ text: string }, string> = {
    name: 'echo',
    description: 'echo input back',
    inputSchema: z.object({ text: z.string() }),
    execute: async (input) => {
      echoCalls.push({ text: input.text });
      return typedOk(`echo:${input.text}`);
    },
  };

  const alwaysFail: ToolDefinition<{ what: string }, string> = {
    name: 'always_fail',
    description: 'always returns error',
    inputSchema: z.object({ what: z.string() }),
    execute: async (input) => {
      failCount.value++;
      return typedErr(`intentional failure: ${input.what}`);
    },
  };

  const registry = new ToolRegistry();
  registry.register(echo);
  registry.register(alwaysFail);
  return { registry, echoCalls, failCount };
}

/**
 * Build a provider stream that emits the given events ONCE, then yields a
 * plain stop on every subsequent call (e.g. agentic re-entries after tool
 * results). Without this, a stateless mock would re-emit tool_calls forever
 * and trip the harness MAX_TOOL_LOOP_ITERATIONS guard.
 */
function streamEmitting(events: Array<{ kind: string; [k: string]: unknown }>): ProviderStreamFn {
  let consumed = false;
  return async function* () {
    if (!consumed) {
      consumed = true;
      for (const e of events) yield e as never;
      return;
    }
    // Subsequent turns (after tool results): just stop.
    yield { kind: 'finish', reason: 'stop' } as never;
  };
}

describe('runCouncilPure + tools (Phase 24 — Council × Tools)', () => {
  it('text-only stream with no tools: no tool execution events emitted (legacy behavior)', async () => {
    const stream: ProviderStreamFn = async function* () {
      yield { kind: 'text', delta: 'plain response' };
      yield { kind: 'finish', reason: 'stop' };
    };
    const events: BrainEvent[] = [];
    for await (const e of runCouncilPure('hello', {
      apiKey: 'sk-test',
      model: 'm',
      provider: 'p',
      councilSize: 1,
      debateMode: false,
      ragContext: '',
      workspaceContext: '',
      providerStream: stream,
    })) {
      events.push(e);
    }
    const types = events.map((e) => e.type);
    expect(types).toContain('agent_start');
    expect(types).toContain('agent_end');
    expect(types).not.toContain('tool_execution_start');
    expect(types).not.toContain('tool_execution_end');
  });

  it('with tool registry: tool_call delta triggers real tool execution and emits tool_execution_end (ok)', async () => {
    const { registry, echoCalls } = buildMixedRegistry();
    const stream = streamEmitting([
      { kind: 'tool_call', toolCallId: 'tc-1', toolName: 'echo', args: { text: 'hello' } },
      { kind: 'finish', reason: 'tool_calls' },
    ]);
    const events = await collect(runCouncilPure('echo please', {
      apiKey: 'sk-test',
      model: 'm',
      provider: 'p',
      councilSize: 1,
      debateMode: false,
      ragContext: '',
      workspaceContext: '',
      providerStream: stream,
      tools: registry,
    }));
    expect(echoCalls).toEqual([{ text: 'hello' }]);
    const start = events.find((e) => e.type === 'tool_execution_start');
    const end = events.find((e) => e.type === 'tool_execution_end');
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    if (start && start.type === 'tool_execution_start') {
      expect(start.toolCallId).toBe('tc-1');
      expect(start.toolName).toBe('echo');
      expect(start.args).toEqual({ text: 'hello' });
    }
    if (end && end.type === 'tool_execution_end') {
      expect(end.toolCallId).toBe('tc-1');
      expect(end.isError).toBe(false);
      expect(typeof end.durationMs).toBe('number');
    }
  });

  it('with tool registry: tool execution error → tool_execution_end with isError=true (graceful failure)', async () => {
    const { registry, failCount } = buildMixedRegistry();
    const stream = streamEmitting([
      { kind: 'tool_call', toolCallId: 'tc-2', toolName: 'always_fail', args: { what: 'boom' } },
      { kind: 'finish', reason: 'tool_calls' },
    ]);
    const events = await collect(runCouncilPure('fail please', {
      apiKey: 'sk-test',
      model: 'm',
      provider: 'p',
      councilSize: 1,
      debateMode: false,
      ragContext: '',
      workspaceContext: '',
      providerStream: stream,
      tools: registry,
    }));
    expect(failCount.value).toBe(1);
    const end = events.find((e) => e.type === 'tool_execution_end');
    expect(end).toBeDefined();
    if (end && end.type === 'tool_execution_end') {
      expect(end.toolCallId).toBe('tc-2');
      expect(end.isError).toBe(true);
      expect(end.result).toContain('intentional failure');
    }
  });

  it('with tool registry: tool_call to unknown tool name → tool_execution_end with isError=true (registry rejects)', async () => {
    const { registry } = buildMixedRegistry();
    const stream = streamEmitting([
      { kind: 'tool_call', toolCallId: 'tc-3', toolName: 'nonexistent', args: {} },
      { kind: 'finish', reason: 'tool_calls' },
    ]);
    const events = await collect(runCouncilPure('do something unknown', {
      apiKey: 'sk-test',
      model: 'm',
      provider: 'p',
      councilSize: 1,
      debateMode: false,
      ragContext: '',
      workspaceContext: '',
      providerStream: stream,
      tools: registry,
    }));
    const end = events.find((e) => e.type === 'tool_execution_end');
    expect(end).toBeDefined();
    if (end && end.type === 'tool_execution_end') {
      expect(end.toolCallId).toBe('tc-3');
      expect(end.isError).toBe(true);
    }
  });

  it('with tool registry: tool_call with invalid args (Zod fails) → tool_execution_end with isError=true', async () => {
    const { registry } = buildMixedRegistry();
    const stream = streamEmitting([
      { kind: 'tool_call', toolCallId: 'tc-4', toolName: 'echo', args: { wrong_field: 123 } },
      { kind: 'finish', reason: 'tool_calls' },
    ]);
    const events = await collect(runCouncilPure('echo with bad args', {
      apiKey: 'sk-test',
      model: 'm',
      provider: 'p',
      councilSize: 1,
      debateMode: false,
      ragContext: '',
      workspaceContext: '',
      providerStream: stream,
      tools: registry,
    }));
    const end = events.find((e) => e.type === 'tool_execution_end');
    expect(end).toBeDefined();
    if (end && end.type === 'tool_execution_end') {
      expect(end.toolCallId).toBe('tc-4');
      expect(end.isError).toBe(true);
    }
  });

  it('with tool registry: mixed text + tool_call stream → both render correctly', async () => {
    const { registry, echoCalls } = buildMixedRegistry();
    const stream: ProviderStreamFn = async function* () {
      yield { kind: 'text', delta: 'before ' };
      yield { kind: 'tool_call', toolCallId: 'tc-5', toolName: 'echo', args: { text: 'mid' } };
      yield { kind: 'text', delta: ' after' };
      yield { kind: 'finish', reason: 'stop' };
    };
    const events = await collect(runCouncilPure('mixed', {
      apiKey: 'sk-test',
      model: 'm',
      provider: 'p',
      councilSize: 1,
      debateMode: false,
      ragContext: '',
      workspaceContext: '',
      providerStream: stream,
      tools: registry,
    }));
    expect(echoCalls).toEqual([{ text: 'mid' }]);
    const start = events.find((e) => e.type === 'tool_execution_start');
    const end = events.find((e) => e.type === 'tool_execution_end');
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    const deltas = events
      .filter((e): e is Extract<BrainEvent, { type: 'message_delta' }> => e.type === 'message_delta')
      .map((e) => e.delta);
    expect(deltas.join('')).toBe('before  after');
  });
});

describe('dispatchCouncil + tools (Task C.1.2 wiring)', () => {
  it('forwards tools from CouncilDispatchOptions to PureCouncilConfig (plumbing smoke test)', async () => {
    const { registry, echoCalls } = buildMixedRegistry();
    const stream = streamEmitting([
      { kind: 'tool_call', toolCallId: 'tc-d-1', toolName: 'echo', args: { text: 'from-dispatcher' } },
      { kind: 'finish', reason: 'tool_calls' },
    ]);
    const events = await collect(dispatchCouncil('test', {
      apiKey: 'sk-test',
      model: 'm',
      provider: 'p',
      councilSize: 1,
      debateMode: false,
      providerStream: stream,
      tools: registry,
    }));
    expect(echoCalls).toEqual([{ text: 'from-dispatcher' }]);
    const start = events.find((e) => e.type === 'tool_execution_start');
    expect(start).toBeDefined();
  });

  it('omitting tools → no tool execution END events (legacy text-only behavior; tool_execution_start may still fire)', async () => {
    const stream = streamEmitting([
      { kind: 'tool_call', toolCallId: 'tc-noop', toolName: 'echo', args: { text: 'ignored' } },
      { kind: 'finish', reason: 'tool_calls' },
    ]);
    const events = await collect(dispatchCouncil('legacy', {
      apiKey: 'sk-test',
      model: 'm',
      provider: 'p',
      councilSize: 1,
      debateMode: false,
      providerStream: stream,
    }));
    const types = events.map((e) => e.type);
    expect(types).not.toContain('tool_execution_end');
  });

  it('forwards maxToolCallsPerTurn without error (config plumbing)', async () => {
    const { registry } = buildMixedRegistry();
    const stream = streamEmitting([
      { kind: 'text', delta: 'hello' },
      { kind: 'finish', reason: 'stop' },
    ]);
    const events = await collect(dispatchCouncil('cfg test', {
      apiKey: 'sk-test',
      model: 'm',
      provider: 'p',
      councilSize: 1,
      debateMode: false,
      providerStream: stream,
      tools: registry,
      maxToolCallsPerTurn: 3,
    }));
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'agent_start')).toBe(true);
    expect(events.some((e) => e.type === 'agent_end')).toBe(true);
  });
});