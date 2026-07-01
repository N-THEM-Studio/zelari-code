/**
 * cli-agentHarnessUsage.test.ts — Task G.4.3
 *
 * Verifies that `AgentHarness.runSingleTurn()` captures provider-reported
 * token usage (from `ProviderDelta { kind: 'usage' }`) and attaches it
 * to the synthesized `message_end` event via `BrainMessageEndEvent.usage`.
 *
 * Three angles:
 *  1. usage delta arrives → message_end carries matching `usage` field.
 *  2. No usage delta → message_end has no `usage` field (graceful absence).
 *  3. Multiple turns → each turn's message_end has its own usage payload
 *     (counter must NOT leak across turns).
 */

import { describe, it, expect } from 'vitest';
import { AgentHarness } from '@zelari/core/harness';
import type { ProviderStreamFn, ProviderDelta } from '@zelari/core/harness';
import type { BrainEvent } from '@zelari/core/events';

function asyncGen(deltas: ProviderDelta[]): ProviderStreamFn {
  return async function* () {
    for (const d of deltas) yield d;
  };
}

async function collect(stream: AsyncIterable<BrainEvent>): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe('AgentHarness attaches provider usage to message_end (Task G.4.3)', () => {
  it('usage delta → message_end carries matching usage payload', async () => {
    const provider = asyncGen([
      { kind: 'text', delta: 'hello' },
      {
        kind: 'usage',
        usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
      },
      { kind: 'finish', reason: 'stop' },
    ]);

    const harness = new AgentHarness({
      model: 'test-model',
      provider: 'minimax',
      sessionId: 'sess-usage-1',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      providerStream: provider,
    });

    const events = await collect(harness.run());
    const msgEnd = events.find((e) => e.type === 'message_end');
    expect(msgEnd).toBeDefined();
    expect(msgEnd?.type).toBe('message_end');
    if (msgEnd?.type === 'message_end') {
      expect(msgEnd.usage).toEqual({
        promptTokens: 12,
        completionTokens: 3,
        totalTokens: 15,
      });
    }
  });

  it('no usage delta → message_end has no usage field', async () => {
    const provider = asyncGen([
      { kind: 'text', delta: 'no-usage-here' },
      { kind: 'finish', reason: 'stop' },
    ]);

    const harness = new AgentHarness({
      model: 'test-model',
      provider: 'minimax',
      sessionId: 'sess-usage-2',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      providerStream: provider,
    });

    const events = await collect(harness.run());
    const msgEnd = events.find((e) => e.type === 'message_end');
    expect(msgEnd).toBeDefined();
    expect(msgEnd?.type).toBe('message_end');
    if (msgEnd?.type === 'message_end') {
      expect(msgEnd.usage).toBeUndefined();
    }
  });

  it('per-turn isolation: each queue-drained turn has its own usage', async () => {
    // Factory provider — first turn yields one usage payload, second turn
    // yields a different one. Each message_end should carry the right one.
    let turnIdx = 0;
    const provider: ProviderStreamFn = (async function* () {
      turnIdx++;
      yield { kind: 'text', delta: `turn-${turnIdx}` };
      yield {
        kind: 'usage',
        usage: {
          promptTokens: turnIdx * 10,
          completionTokens: turnIdx,
          totalTokens: turnIdx * 11,
        },
      };
      yield { kind: 'finish', reason: 'stop' };
    }) as ProviderStreamFn;

    const harness = new AgentHarness({
      model: 'test-model',
      provider: 'minimax',
      sessionId: 'sess-usage-3',
      messages: [{ role: 'user', content: 'multi' }],
      tools: [],
      providerStream: provider,
    });

    harness.enqueue('next turn');
    const events = await collect(harness.run());
    const msgEnds = events.filter((e) => e.type === 'message_end');
    expect(msgEnds.length).toBe(2);

    // Each message_end has its own usage — first turn (idx=1) and second (idx=2)
    const ends = msgEnds.filter((e) => e.type === 'message_end') as Array<{
      usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    }>;
    const usages = ends.map((e) => e.usage).filter(Boolean);
    expect(usages.length).toBe(2);
    // The two usages should be different (per-turn isolation)
    expect(usages[0]?.promptTokens).not.toBe(usages[1]?.promptTokens);
  });
});
