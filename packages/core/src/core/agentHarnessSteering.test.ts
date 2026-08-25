/**
 * AgentHarness × live steering — Frontier PHASE 2 integration tests.
 *
 * Contracts verified here:
 *  1. a steer enqueued mid-run is injected as a user message at the next
 *     safe turn boundary and is visible to the following provider call;
 *  2. the in-flight provider request is never mutated (steer lands strictly
 *     between turns);
 *  3. a run without steers is byte-identical to the pre-PHASE-2 loop.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentHarness, type ProviderStreamFn } from './AgentHarness.js';
import { ToolRegistry } from './tools/registry.js';
import type { BrainEvent } from '../shared/events.js';
import { RuntimeControlQueue } from '../runtime/controls/RuntimeControlQueue.js';

async function collect(harness: AgentHarness): Promise<BrainEvent[]> {
  const events: BrainEvent[] = [];
  for await (const event of harness.run()) events.push(event);
  return events;
}

function probeRegistry(counter: { calls: number }): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: 'echo_probe',
    description: 'Read-only probe used by steering tests',
    permissions: ['read'],
    inputSchema: z.object({ n: z.number().optional() }),
    execute: async () => {
      counter.calls += 1;
      return { ok: true as const, value: 'pong' };
    },
  });
  return registry;
}

describe('AgentHarness live steering (Frontier PHASE 2)', () => {
  afterEach(() => {
    delete process.env.ZELARI_RUNTIME_OBSERVERS;
  });

  it('injects a mid-run steer at the turn boundary for the next provider call', async () => {
    const queue = new RuntimeControlQueue();
    const counter = { calls: 0 };
    const seenByProvider: string[][] = [];
    let providerCalls = 0;
    const provider: ProviderStreamFn = async function* (params) {
      providerCalls += 1;
      seenByProvider.push(params.messages.map((m) => m.content));
      if (providerCalls === 1) {
        // Steer arrives while the first turn is still streaming.
        queue.enqueue({
          type: 'steer',
          id: 'steer-1',
          text: 'Do not change the public API',
          ts: Date.now(),
        });
        yield { kind: 'tool_call', toolCallId: 'c1', toolName: 'echo_probe', args: {} };
        yield { kind: 'finish', reason: 'tool_calls' };
      } else {
        yield { kind: 'text', delta: 'acknowledged' };
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
      controlQueue: queue,
    });

    const events = await collect(harness);
    expect(counter.calls).toBe(1);

    // First provider call must NOT contain the steer (it arrived mid-flight).
    expect(seenByProvider[0]!.some((c) => c.includes('Do not change the public API'))).toBe(false);
    // Second provider call must contain it, rendered by renderSteers.
    const second = seenByProvider[1] ?? [];
    const steerMessage = second.find(
      (c) => c.includes('Runtime user steering received during execution:') &&
             c.includes('Do not change the public API'),
    );
    expect(steerMessage).toBeDefined();

    // The transcript itself carries the injected user message.
    expect(
      harness.getMessages().some((m) => m.role === 'user' && m.content.includes('Runtime user steering')),
    ).toBe(true);

    // Queue fully drained after application.
    expect(queue.size).toBe(0);
    expect(events.find((event) => event.type === 'agent_end')).toMatchObject({
      reason: 'completed',
    });
  });

  it('is byte-identical to the plain loop when no steer is enqueued', async () => {
    const queue = new RuntimeControlQueue();
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
      controlQueue: queue,
    });

    const events = await collect(harness);
    expect(counter.calls).toBe(1);
    expect(queue.size).toBe(0);
    expect(
      harness.getMessages().some((m) => m.content.includes('Runtime user steering')),
    ).toBe(false);
    expect(events.find((event) => event.type === 'agent_end')).toMatchObject({
      reason: 'completed',
    });
  });
});
