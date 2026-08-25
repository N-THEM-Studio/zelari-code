import { describe, expect, it } from 'vitest';
import type { BrainEvent } from '@zelari/core/shared/events';
import { createTaskTool } from './taskTool.js';
import type { SubAgentHarness, TaskToolDeps } from './taskTool.js';

/** Minimal provider stream: no model output, text-only finish. */
const providerStream = async function* (): AsyncGenerator<never> {
  // intentional: nothing to stream
};

function fakeRegistry(): any {
  return {
    invoke: async () => ({ output: '' }),
    fingerprints: () => [],
    toOpenAITools: () => [],
  };
}

function makeDeps(events: BrainEvent[]): TaskToolDeps {
  return {
    createSubAgentContext: (async () => ({
      model: 'test-model',
      provider: 'test-provider',
      cwd: '.',
      registry: fakeRegistry(),
      tools: [],
      providerStream,
    })) as unknown as TaskToolDeps['createSubAgentContext'],
    harnessFactory: (() =>
      ({
        run: async function* (): AsyncGenerator<BrainEvent> {
          const mk = (e: object) =>
            ({ id: 'e', ts: 0, sessionId: 's', ...e }) as BrainEvent;
          yield mk({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'npm test' } });
          yield mk({ type: 'tool_execution_end', toolCallId: 't1', isError: false, durationMs: 5, result: 'ok' });
          yield mk({ type: 'message_start' });
          yield mk({ type: 'message_delta', delta: 'done' });
          yield mk({ type: 'message_end' });
        },
        cancel: () => {},
      }) as SubAgentHarness) as unknown as TaskToolDeps['harnessFactory'],
    onTentacleEvent: (ev: BrainEvent) => {
      events.push(ev);
    },
  } as TaskToolDeps;
}

describe('task tool tentacle activity events (§37)', () => {
  it('emits spawned/status/tool started+completed/ended with tentacle identity', async () => {
    const events: BrainEvent[] = [];
    const tool = createTaskTool(makeDeps(events));
    const res = (await (tool as { execute: (a: unknown, c: unknown) => Promise<unknown> }).execute(
      { agent: 'explore', prompt: 'map the auth module', description: 'auth architecture' },
      { sessionId: 'test', cwd: '.' },
    )) as { ok: boolean };

    expect(res.ok).toBe(true);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('agent_spawned');
    expect(types).toContain('agent_status');
    expect(types).toContain('agent_tool');
    expect(types[types.length - 1]).toBe('agent_ended');

    const spawned = events.find((e) => e.type === 'agent_spawned') as unknown as Record<string, unknown>;
    expect(spawned.role).toBe('explore');
    expect(spawned.title).toBe('auth architecture');
    expect(spawned.model).toBe('test-model');
    expect(typeof spawned.agentId).toBe('string');

    const tools = events.filter((e) => e.type === 'agent_tool') as unknown as Record<string, unknown>[];
    expect(tools).toHaveLength(2);
    expect(tools[0].status).toBe('started');
    expect(tools[0].tool).toBe('bash');
    expect(tools[1].status).toBe('completed');
    expect(tools[1].durationMs).toBe(5);
    expect(tools[0].agentId).toBe(spawned.agentId);

    const ended = events[events.length - 1] as unknown as Record<string, unknown>;
    expect(ended.ok).toBe(true);
    expect(ended.agentId).toBe(spawned.agentId);
    expect(typeof ended.durationMs).toBe('number');
  });

  it('no sink wired → zero events, run unaffected', async () => {
    const deps = makeDeps([]);
    delete (deps as Partial<TaskToolDeps>).onTentacleEvent;
    const tool = createTaskTool(deps);
    const res = (await (tool as { execute: (a: unknown, c: unknown) => Promise<unknown> }).execute(
      { agent: 'explore', prompt: 'x', description: 'd' },
      { sessionId: 'test', cwd: '.' },
    )) as { ok: boolean };
    expect(res.ok).toBe(true);
  });
});
