import { describe, expect, it, vi } from 'vitest';
import { AgentHarness } from '@zelari/core/harness';
import type { ProviderStreamFn } from '@zelari/core/harness';
import type { BrainEvent } from '@zelari/core/events';
import type { MemoryService } from '@zelari/core/memory';

async function collect(stream: AsyncIterable<BrainEvent>): Promise<BrainEvent[]> {
  const events: BrainEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('AgentHarness native memory context', () => {
  it('injects bounded memory ephemerally after the stable system prefix', async () => {
    const buildContext = vi.fn(async () => ({
      text: '[ZELARI MEMORY]\nmem_1 constraint 0.90:\nUse WAL.\n[/ZELARI MEMORY]',
      memories: [], usedChars: 68, budgetChars: 321, truncated: false,
    }));
    const memory = { buildContext } as unknown as MemoryService;
    const originalMessages = [
      { role: 'system' as const, content: 'Stable system prompt.' },
      { role: 'user' as const, content: 'How should memory writes work?' },
    ];
    let providerMessages: Array<{ role: string; content: string }> = [];
    const provider: ProviderStreamFn = async function* (request) {
      providerMessages = request.messages;
      yield { kind: 'text', delta: 'Use the recalled constraint.' };
      yield { kind: 'finish', reason: 'stop' };
    };
    const harness = new AgentHarness({
      model: 'test', provider: 'openai-compatible', messages: originalMessages,
      tools: [], providerStream: provider, memoryService: memory,
      memoryContextChars: 321,
    });

    await collect(harness.run());
    expect(buildContext).toHaveBeenCalledWith(expect.objectContaining({
      text: 'How should memory writes work?', maxChars: 321, useGraph: true,
    }));
    expect(providerMessages.map((message) => message.role)).toEqual(['system', 'system', 'user']);
    expect(providerMessages[1]?.content).toContain('[ZELARI MEMORY]');
    expect(originalMessages[1]?.content).toBe('How should memory writes work?');
    expect(originalMessages.some((message) => message.content.includes('[ZELARI MEMORY]'))).toBe(false);
  });

  it('warns and continues when recall fails', async () => {
    const memory = {
      buildContext: vi.fn(async () => { throw new Error('database unavailable'); }),
    } as unknown as MemoryService;
    let called = false;
    const provider: ProviderStreamFn = async function* () {
      called = true;
      yield { kind: 'text', delta: 'fallback response' };
      yield { kind: 'finish', reason: 'stop' };
    };
    const harness = new AgentHarness({
      model: 'test', provider: 'openai-compatible',
      messages: [{ role: 'user', content: 'Continue safely.' }],
      tools: [], providerStream: provider, memoryService: memory,
    });
    const events = await collect(harness.run());
    expect(called).toBe(true);
    expect(events.some((event) =>
      event.type === 'error' && event.code === 'memory_recall_failed' && event.severity === 'recoverable',
    )).toBe(true);
  });
});
