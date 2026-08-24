import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentHarness, type ProviderStreamFn } from './AgentHarness.js';
import type { BrainEvent } from '../shared/events.js';
import { ToolRegistry } from './tools/registry.js';

async function collect(harness: AgentHarness): Promise<BrainEvent[]> {
  const events: BrainEvent[] = [];
  for await (const event of harness.run()) events.push(event);
  return events;
}

function mutationRegistry(): { registry: ToolRegistry; calls: () => number } {
  const registry = new ToolRegistry();
  let count = 0;
  // Deliberately not a built-in name: liveness must use permission metadata.
  registry.register({
    name: 'commit_change',
    description: 'Apply one project mutation',
    permissions: ['write'],
    sideEffect: 'local',
    inputSchema: z.object({}),
    execute: async () => {
      count += 1;
      return { ok: true as const, value: { changed: true } };
    },
  });
  return { registry, calls: () => count };
}

describe('AgentHarness build liveness', () => {
  it('recovers a zero-write stop and completes only after a successful mutation', async () => {
    const { registry, calls } = mutationRegistry();
    const requests: Parameters<ProviderStreamFn>[0][] = [];
    let turn = 0;
    const provider: ProviderStreamFn = async function* (params) {
      requests.push(params);
      turn += 1;
      if (turn === 1) {
        yield { kind: 'text', delta: 'I would change the file.' };
        yield { kind: 'finish', reason: 'stop' };
      } else if (turn === 2) {
        yield {
          kind: 'tool_call',
          toolCallId: 'mutation-1',
          toolName: 'commit_change',
          args: {},
        };
        yield { kind: 'finish', reason: 'tool_calls' };
      } else {
        yield { kind: 'text', delta: 'Implemented.' };
        yield { kind: 'finish', reason: 'stop' };
      }
    };

    const harness = new AgentHarness({
      model: 'grok-4.6',
      provider: 'grok',
      sessionId: 'stable-conversation-id',
      messages: [{ role: 'user', content: 'implement it' }],
      tools: [{ name: 'commit_change', description: 'mutate', parameters: {} }],
      toolRegistry: registry,
      providerStream: provider,
      buildLiveness: { mutationRequired: true, maxRecoveries: 2 },
    });

    const events = await collect(harness);
    expect(calls()).toBe(1);
    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.conversationId === 'stable-conversation-id')).toBe(true);
    expect(requests[1]!.generation).toMatchObject({
      purpose: 'build-recovery',
      toolChoice: 'required',
      recoveryAttempt: 1,
    });
    expect(harness.getBuildProgress()).toMatchObject({
      mutationsAttempted: 1,
      mutationsSucceeded: 1,
      recoveries: 1,
    });
    expect(events.find((event) => event.type === 'agent_end')).toMatchObject({
      reason: 'completed',
    });
  });

  it('fails explicitly after two zero-mutation recoveries without looping forever', async () => {
    const { registry } = mutationRegistry();
    const attempts: number[] = [];
    let calls = 0;
    const provider: ProviderStreamFn = async function* (params) {
      calls += 1;
      if (params.generation?.recoveryAttempt) attempts.push(params.generation.recoveryAttempt);
      yield { kind: 'text', delta: 'No tool call.' };
      yield { kind: 'finish', reason: 'stop' };
    };
    const harness = new AgentHarness({
      model: 'grok-4.6',
      provider: 'grok',
      messages: [{ role: 'user', content: 'fix it' }],
      tools: [{ name: 'commit_change', description: 'mutate', parameters: {} }],
      toolRegistry: registry,
      providerStream: provider,
      buildLiveness: { mutationRequired: true, maxRecoveries: 2 },
    });

    const events = await collect(harness);
    expect(calls).toBe(3);
    expect(attempts).toEqual([1, 2]);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      severity: 'fatal',
      code: 'build_liveness_stalled',
    }));
    expect(events.find((event) => event.type === 'agent_end')).toMatchObject({ reason: 'error' });
  });

  it('allows a structured clarification pause without forcing a mutation', async () => {
    let calls = 0;
    const provider: ProviderStreamFn = async function* () {
      calls += 1;
      yield {
        kind: 'text',
        delta: '---QUESTION---\n{"question":"Which target?","choices":["A","B"]}',
      };
      yield { kind: 'finish', reason: 'stop' };
    };
    const harness = new AgentHarness({
      model: 'grok-4.6',
      provider: 'grok',
      messages: [{ role: 'user', content: 'implement it' }],
      tools: [],
      providerStream: provider,
      buildLiveness: { mutationRequired: true },
    });
    const events = await collect(harness);
    expect(calls).toBe(1);
    expect(events.find((event) => event.type === 'agent_end')).toMatchObject({ reason: 'completed' });
  });

  it('does not misreport completion when the provider fails before mutation', async () => {
    const provider: ProviderStreamFn = async function* () {
      yield { kind: 'error', message: 'upstream unavailable' };
    };
    const harness = new AgentHarness({
      model: 'grok-4.6',
      provider: 'grok',
      messages: [{ role: 'user', content: 'implement it' }],
      tools: [],
      providerStream: provider,
      buildLiveness: { mutationRequired: true },
    });

    const events = await collect(harness);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      severity: 'fatal',
      code: 'build_liveness_provider_error',
    }));
    expect(events.find((event) => event.type === 'agent_end')).toMatchObject({ reason: 'error' });
  });

  it('does not count read-only task tentacles as project mutations', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'task',
      description: 'delegate',
      permissions: ['read', 'network', 'write', 'execute'],
      inputSchema: z.object({ agent: z.string() }),
      execute: async () => ({ ok: true as const, value: 'explored' }),
    });
    let turn = 0;
    const provider: ProviderStreamFn = async function* () {
      turn += 1;
      if (turn === 1) {
        yield {
          kind: 'tool_call',
          toolCallId: 'explore-1',
          toolName: 'task',
          args: { agent: 'explore' },
        };
        yield { kind: 'finish', reason: 'tool_calls' };
      } else {
        yield { kind: 'finish', reason: 'stop' };
      }
    };
    const harness = new AgentHarness({
      model: 'grok-4.6',
      provider: 'grok',
      messages: [{ role: 'user', content: 'implement it' }],
      tools: [{ name: 'task', description: 'delegate', parameters: {} }],
      toolRegistry: registry,
      providerStream: provider,
      buildLiveness: { mutationRequired: true, maxRecoveries: 1 },
    });
    const events = await collect(harness);
    expect(harness.getBuildProgress().mutationsSucceeded).toBe(0);
    expect(events.find((event) => event.type === 'agent_end')).toMatchObject({ reason: 'error' });
  });

  it('does not count a successful dry-run as an on-disk mutation', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'preview_change',
      description: 'preview a write',
      permissions: ['write'],
      inputSchema: z.object({ dryRun: z.boolean() }),
      execute: async () => ({ ok: true as const, value: { applied: true, dryRun: true } }),
    });
    let turn = 0;
    const provider: ProviderStreamFn = async function* () {
      turn += 1;
      if (turn === 1) {
        yield {
          kind: 'tool_call',
          toolCallId: 'preview-1',
          toolName: 'preview_change',
          args: { dryRun: true },
        };
        yield { kind: 'finish', reason: 'tool_calls' };
      } else {
        yield { kind: 'finish', reason: 'stop' };
      }
    };
    const harness = new AgentHarness({
      model: 'grok-4.6',
      provider: 'grok',
      messages: [{ role: 'user', content: 'implement it' }],
      tools: [{ name: 'preview_change', description: 'preview', parameters: {} }],
      toolRegistry: registry,
      providerStream: provider,
      buildLiveness: { mutationRequired: true, maxRecoveries: 0 },
    });

    const events = await collect(harness);
    expect(harness.getBuildProgress().mutationsSucceeded).toBe(0);
    expect(events.find((event) => event.type === 'agent_end')).toMatchObject({ reason: 'error' });
  });

  it('keeps volatile request tails out of append-only persistent history', async () => {
    const requests: Array<Parameters<ProviderStreamFn>[0]['messages']> = [];
    let status = 'RESOURCE STATUS\nRemaining: 4';
    let turn = 0;
    const provider: ProviderStreamFn = async function* (params) {
      requests.push(params.messages);
      turn += 1;
      if (turn === 1) {
        status = 'RESOURCE STATUS\nRemaining: 3';
        yield { kind: 'tool_call', toolCallId: 'r1', toolName: 'observe', args: {} };
        yield { kind: 'finish', reason: 'tool_calls' };
      } else {
        yield { kind: 'finish', reason: 'stop' };
      }
    };
    const registry = new ToolRegistry();
    registry.register({
      name: 'observe',
      description: 'read only',
      permissions: ['read'],
      sideEffect: 'none',
      inputSchema: z.object({}),
      execute: async () => ({ ok: true as const, value: 'ok' }),
    });
    const harness = new AgentHarness({
      model: 'deepseek-v4-pro',
      provider: 'deepseek',
      messages: [{ role: 'user', content: 'inspect' }],
      tools: [{ name: 'observe', description: 'read', parameters: {} }],
      toolRegistry: registry,
      providerStream: provider,
      requestTail: () => [{ role: 'system', content: status }],
    });

    await collect(harness);
    expect(requests[0]!.at(-1)?.content).toContain('Remaining: 4');
    expect(requests[1]!.at(-1)?.content).toContain('Remaining: 3');
    expect(harness.getMessages().some((message) => message.content.startsWith('RESOURCE STATUS'))).toBe(false);
    const stableFirst = requests[0]!.slice(0, -1);
    expect(requests[1]!.slice(0, stableFirst.length)).toEqual(stableFirst);
  });
});
