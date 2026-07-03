import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { dispatchCouncil } from '../../src/cli/councilDispatcher.js';
import { runCouncilPure } from '@zelari/core/council';
import { ToolRegistry } from '@zelari/core/harness/tools/registry';
import { typedOk, typedErr, type ToolDefinition } from '@zelari/core/harness/tools/toolTypes';
import type { ProviderStreamFn } from '@zelari/core/harness';
import type { BrainEvent } from '@zelari/core/events';

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

  it('omitting tools AND opting out of workspace defaults → no tool execution END events', async () => {
    // Phase 4 wiring: by default dispatchCouncil now wires workspace
    // stubs, so even with no explicit `tools` the registry contains
    // 9 workspace tool definitions. To verify the legacy text-only
    // path, pass `disableWorkspaceTools: true` (an internal flag the
    // CLI itself never sets — only tests use it).
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
      disableWorkspaceTools: true,
    } as Parameters<typeof dispatchCouncil>[1]));
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

describe('ToolRegistry — hallucinated tool-name recovery (v0.7.5)', () => {
  // Live test 2026-07-03: council members called Read / Glob / list_dir /
  // searchRAG — names from other agent stacks — burning tool-budget slots
  // on guaranteed failures. The registry now suggests the canonical name.
  it('suggests the canonical tool for common hallucinated names', async () => {
    const registry = new ToolRegistry();
    const mkTool = (name: string): ToolDefinition<{ q?: string }, string> => ({
      name,
      description: 'x',
      inputSchema: z.object({ q: z.string().optional() }),
      execute: async () => typedOk('ok'),
    });
    registry.register(mkTool('read_file'));
    registry.register(mkTool('list_files'));
    registry.register(mkTool('searchDocuments'));

    for (const [wrong, right] of [
      ['Read', 'read_file'],
      ['Glob', 'list_files'],
      ['list_dir', 'list_files'],
      ['searchRAG', 'searchDocuments'],
    ] as const) {
      const res = await registry.invoke(wrong, {});
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toContain(`Did you mean "${right}"`);
      }
    }
  });

  it('does not suggest when the alias target is not registered', async () => {
    const registry = new ToolRegistry();
    const res = await registry.invoke('searchRAG', {});
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).not.toContain('Did you mean');
      expect(res.error).toContain('not found');
    }
  });
});

describe('council prompts advertise ONLY executable tools (v0.7.5)', () => {
  // v0.7.3 filtered the tool SCHEMAS but not the AVAILABLE TOOLS prompt
  // block — members still read "searchRAG: …" in their system prompt and
  // called it (live test 2026-07-03). The prompt text must match the
  // executable registry.
  it('system prompts contain no tool-doc line for non-executable tools', async () => {
    const { registry } = buildMixedRegistry(); // registers echo + always_fail only
    const capturedSystemPrompts: string[] = [];
    const stream: ProviderStreamFn = async function* (params: unknown) {
      const messages = (params as { messages?: Array<{ role: string; content: string }> })?.messages ?? [];
      for (const m of messages) {
        if (m.role === 'system') capturedSystemPrompts.push(m.content);
      }
      yield { kind: 'finish', reason: 'stop' } as never;
    };
    await collect(runCouncilPure('plan a feature', {
      apiKey: 'sk-test',
      model: 'm',
      provider: 'p',
      councilSize: 3,
      debateMode: false,
      ragContext: '',
      workspaceContext: '',
      providerStream: stream,
      tools: registry,
    }));
    expect(capturedSystemPrompts.length).toBeGreaterThan(0);
    // No AVAILABLE TOOLS doc line may advertise a tool the registry can't run.
    for (const prompt of capturedSystemPrompts) {
      expect(prompt).not.toMatch(/^- searchRAG:/m);
      expect(prompt).not.toMatch(/^- buildMindMap:/m);
      expect(prompt).not.toMatch(/^- addNode:/m);
    }
  });

  it('advertises file tools to members whose role declares them (v0.7.5 harness bridge)', async () => {
    // Before the harnessToolBridge, roles declared read_file/list_files but
    // getAllTools() didn't know those names → getToolDescriptions skipped
    // them → members saw NO file tools and hallucinated Read/Glob/list_dir.
    const registry = new ToolRegistry();
    const fileTool: ToolDefinition<{ path: string }, string> = {
      name: 'read_file',
      description: 'read a file',
      permissions: [],
      inputSchema: z.object({ path: z.string() }),
      execute: async () => typedOk('content'),
    };
    registry.register(fileTool);
    const capturedSystemPrompts: string[] = [];
    const stream: ProviderStreamFn = async function* (params: unknown) {
      const messages = (params as { messages?: Array<{ role: string; content: string }> })?.messages ?? [];
      for (const m of messages) {
        if (m.role === 'system') capturedSystemPrompts.push(m.content);
      }
      yield { kind: 'finish', reason: 'stop' } as never;
    };
    await collect(runCouncilPure('inspect the repo', {
      apiKey: 'sk-test',
      model: 'm',
      provider: 'p',
      councilSize: 3,
      debateMode: false,
      ragContext: '',
      workspaceContext: '',
      providerStream: stream,
      tools: registry,
    }));
    // At least one member (roles declare read_file) must see its doc line.
    const joined = capturedSystemPrompts.join('\n===\n');
    expect(joined).toMatch(/^- read_file: /m);
  });

  it('executor-only tools are advertised to specialists (v0.7.5 Bug B fix)', async () => {
    // Bug B fix: when the executor registry contains tools NOT in role.tools
    // (e.g. workspace stubs: createPhase, addIdea, createDocument), the
    // prompt and the harness tool list must still expose them so the LLM
    // can call them by name. Before the fix, filterExecutable intersected
    // role.tools with executor names, leaving the LLM with zero tools
    // visible whenever the two sets were disjoint.
    //
    // Strategy: register a custom tool globally via registerCustomTool so
    // it shows up in getAllTools(). Then build a ToolRegistry containing
    // only that tool and pass it as `config.tools`. Without the fix, every
    // council member's agentToolNames list would be empty (because the
    // role.tools and executor names are disjoint). With the fix, the
    // union of role.tools + executor names means the custom tool is
    // visible to at least one member.
    const { registerCustomTool, getAllTools } = await import('@zelari/core/skills');

    const customName = `bugB_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    registerCustomTool({
      name: customName,
      description: 'Bug B regression tool',
      parameters: {
        type: 'object',
        properties: { input: { type: 'string' } },
        additionalProperties: false,
      },
      execute: async () => 'ok',
      // EnhancedToolDefinition has these; ToolDefinition doesn't have
      // permissions. Cast through never to satisfy the static type.
    } as never);

    try {
      // Sanity: the custom tool must be in getAllTools() now.
      const allNames = getAllTools().map((t) => t.name);
      expect(allNames).toContain(customName);

      // Build a registry with ONLY the custom tool — disjoint from any
      // role.tools, which is the precise condition that triggered the bug.
      const registry = new ToolRegistry();
      const customDef: ToolDefinition<{ input?: string }, string> = {
        name: customName,
        description: 'Bug B regression tool',
        permissions: [],
        inputSchema: z.object({ input: z.string().optional() }),
        execute: async () => typedOk('ok'),
        jsonSchema: {
          type: 'object',
          properties: { input: { type: 'string' } },
          additionalProperties: false,
        },
      };
      registry.register(customDef);

      const seenByMember = new Set<string>();
      const stream: ProviderStreamFn = async function* (params: unknown) {
        const tools = (params as { tools?: Array<{ name?: string; function?: { name?: string } }> })?.tools ?? [];
        for (const t of tools) {
          // AgentToolSpec has `name` at top level; openaiCompatibleProvider
          // wraps it as `{type:'function', function:{...}}` but the
          // harness passes AgentToolSpec to providerStream. Try both.
          const n = t.name ?? t.function?.name;
          if (n) seenByMember.add(n);
        }
        yield { kind: 'finish', reason: 'stop' } as never;
      };
      await collect(runCouncilPure('plan the design', {
        apiKey: 'sk-test',
        model: 'm',
        provider: 'p',
        councilSize: 3,
        debateMode: false,
        ragContext: '',
        workspaceContext: '',
        providerStream: stream,
        tools: registry,
      }));

      // After the fix, the custom tool (which is in the executor registry
      // AND in getAllTools(), but NOT in any role.tools) must be visible
      // to at least one council member's harness call.
      expect(seenByMember.has(customName)).toBe(true);
    } finally {
      // Cleanup: unregister so other tests aren't polluted. (vitest runs
      // tests in the same module instance; getAllTools() is module-global.)
      const { unregisterCustomTool } = await import('@zelari/core/skills');
      unregisterCustomTool(customName);
    }
  });
});