/**
 * AgentHarness × Observer runtime — Frontier PHASE 1 integration tests.
 *
 * Contracts verified here:
 *  1. observers OFF (no config.observers, env flag unset) → inert loop;
 *  2. observer `deny_tool` → tool blocked with a model-visible reason;
 *  3. RepetitionGuard stopAfter → cooperative stop (agent_end 'cancelled');
 *  4. env flag builds the default bus (RepetitionGuard).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentHarness, type ProviderStreamFn } from './AgentHarness.js';
import { ToolRegistry } from './tools/registry.js';
import type { BrainEvent } from '../shared/events.js';
import { RepetitionGuard } from '../runtime/guards/RepetitionGuard.js';
import {
  buildRuntimeObserverBus,
  runtimeObserversEnabled,
} from '../runtime/observers/ObserverBus.js';
import type {
  AgentObserver,
  ObserverDescriptor,
  ToolCallEvent,
} from '../runtime/observers/types.js';

async function collect(harness: AgentHarness): Promise<BrainEvent[]> {
  const events: BrainEvent[] = [];
  for await (const event of harness.run()) events.push(event);
  return events;
}

function probeRegistry(counter: { calls: number }): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: 'echo_probe',
    description: 'Read-only probe used by observer tests',
    permissions: ['read'],
    inputSchema: z.object({ n: z.number().optional() }),
    execute: async () => {
      counter.calls += 1;
      return { ok: true as const, value: 'pong' };
    },
  });
  return registry;
}

describe('AgentHarness observer runtime (Frontier PHASE 1)', () => {
  afterEach(() => {
    delete process.env.ZELARI_RUNTIME_OBSERVERS;
  });

  it('is inert when no observers are configured and the env flag is off', async () => {
    expect(runtimeObserversEnabled()).toBe(false);
    expect(buildRuntimeObserverBus()).toBeUndefined();

    const counter = { calls: 0 };
    let providerCalls = 0;
    const provider: ProviderStreamFn = async function* () {
      providerCalls += 1;
      if (providerCalls === 1) {
        yield { kind: 'tool_call', toolCallId: 'c1', toolName: 'echo_probe', args: {} };
        yield { kind: 'finish', reason: 'tool_calls' };
      } else {
        yield { kind: 'text', delta: 'done' };
        yield { kind: 'finish', reason: 'stop' };
      }
    };
    const harness = new AgentHarness({
      model: 'test-model',
      provider: 'test',
      messages: [{ role: 'user', content: 'probe' }],
      tools: [{ name: 'echo_probe', description: 'probe', parameters: {} }],
      toolRegistry: probeRegistry(counter),
      providerStream: provider,
    });

    const events = await collect(harness);
    expect(counter.calls).toBe(1);
    // Inert loop: no observer injections and no observer denials.
    expect(harness.getMessages().some((message) => message.content.includes('Reassess'))).toBe(false);
    expect(events.some((event) => String((event as { result?: unknown }).result ?? '').includes('[observers]'))).toBe(false);
    expect(events.find((event) => event.type === 'agent_end')).toMatchObject({
      reason: 'completed',
    });
  });

  it('blocks the tool and surfaces the reason when an observer denies it', async () => {
    const counter = { calls: 0 };
    const denyObserver: AgentObserver = {
      onToolCall: async (_event: ToolCallEvent) => ({
        action: 'deny_tool' as const,
        reason: 'test policy denies probes',
      }),
    };
    const observers: ObserverDescriptor[] = [
      { id: 'test-deny', priority: 20, failureMode: 'warn', observer: denyObserver },
    ];
    let providerCalls = 0;
    const provider: ProviderStreamFn = async function* () {
      providerCalls += 1;
      if (providerCalls === 1) {
        yield { kind: 'tool_call', toolCallId: 'c-deny', toolName: 'echo_probe', args: {} };
        yield { kind: 'finish', reason: 'tool_calls' };
      } else {
        yield { kind: 'text', delta: 'noted' };
        yield { kind: 'finish', reason: 'stop' };
      }
    };
    const harness = new AgentHarness({
      model: 'test-model',
      provider: 'test',
      messages: [{ role: 'user', content: 'probe' }],
      tools: [{ name: 'echo_probe', description: 'probe', parameters: {} }],
      toolRegistry: probeRegistry(counter),
      providerStream: provider,
      observers,
    });

    const events = await collect(harness);
    expect(counter.calls).toBe(0); // never dispatched
    const denyEnd = events.find(
      (event) =>
        event.type === 'tool_execution_end' &&
        typeof (event as { result?: unknown }).result === 'string' &&
        ((event as { result: string }).result).includes('[observers]'),
    );
    expect(denyEnd).toBeDefined();
    expect((denyEnd as { result: string }).result).toContain('test policy denies probes');
    expect(events.find((event) => event.type === 'agent_end')).toMatchObject({
      reason: 'completed',
    });
  });

  it('stops cooperatively when RepetitionGuard reaches stopAfter', async () => {
    const counter = { calls: 0 };
    const observers: ObserverDescriptor[] = [
      {
        id: 'repetition',
        priority: 30,
        failureMode: 'warn',
        observer: new RepetitionGuard({ warnAfter: 1, stopAfter: 2 }),
      },
    ];
    let providerCalls = 0;
    const provider: ProviderStreamFn = async function* () {
      providerCalls += 1;
      if (providerCalls > 10) {
        yield { kind: 'text', delta: 'halting' };
        yield { kind: 'finish', reason: 'stop' };
        return;
      }
      yield { kind: 'tool_call', toolCallId: 'c-loop', toolName: 'echo_probe', args: {} };
      yield { kind: 'finish', reason: 'tool_calls' };
    };
    const harness = new AgentHarness({
      model: 'test-model',
      provider: 'test',
      messages: [{ role: 'user', content: 'probe' }],
      tools: [{ name: 'echo_probe', description: 'probe', parameters: {} }],
      toolRegistry: probeRegistry(counter),
      providerStream: provider,
      observers,
    });

    const events = await collect(harness);
    // 1st identical call: warn-inject → allowed → runs. 2nd: stop → denied.
    expect(counter.calls).toBe(1);
    const reassess = harness
      .getMessages()
      .find((message) => message.role === 'user' && message.content.includes('Reassess'));
    expect(reassess).toBeDefined();
    const denyEnd = events.find(
      (event) =>
        event.type === 'tool_execution_end' &&
        typeof (event as { result?: unknown }).result === 'string' &&
        ((event as { result: string }).result).includes('repeated tool call'),
    );
    expect(denyEnd).toBeDefined();
    expect(events.find((event) => event.type === 'agent_end')).toMatchObject({
      reason: 'cancelled',
    });
  });

  it('builds the default guard bus when ZELARI_RUNTIME_OBSERVERS is on', () => {
    process.env.ZELARI_RUNTIME_OBSERVERS = '1';
    expect(runtimeObserversEnabled()).toBe(true);
    const bus = buildRuntimeObserverBus();
    expect(bus).toBeDefined();
    expect(bus!.size).toBe(7); // 4 guards + reasoning-watchdog + trace + metrics
  });
});
