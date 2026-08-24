import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderStreamFn } from '@zelari/core/harness';
import { openaiCompatibleProvider } from '../../src/cli/provider/openai-compatible.js';

const originalFetch = globalThis.fetch;

function doneResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function drain(
  provider: ProviderStreamFn,
  params: Parameters<ProviderStreamFn>[0],
): Promise<void> {
  for await (const _delta of provider(params)) {
    // drain
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('OpenAI-compatible provider profile serialization', () => {
  it('sends stable x-grok-conv-id and forces only the first recovery turn', async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = vi.fn(async (_input, init) => {
      calls.push(init ?? {});
      return doneResponse();
    }) as typeof fetch;
    const provider = openaiCompatibleProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.x.ai/v1',
      model: 'grok-4.6',
      providerId: 'openai-compatible',
      extraHeaders: { 'x-client-test': 'yes' },
    });
    const base = {
      messages: [{ role: 'user' as const, content: 'implement' }],
      model: 'grok-4.6',
      provider: 'openai-compatible',
      tools: [{ name: 'mutate', description: 'write', parameters: {} }],
      conversationId: 'session-stable-123',
    };

    await drain(provider, {
      ...base,
      generation: { purpose: 'build-recovery', toolChoice: 'required', recoveryAttempt: 1 },
    });
    await drain(provider, {
      ...base,
      generation: { purpose: 'build-recovery', toolChoice: 'required', recoveryAttempt: 2 },
    });

    const firstHeaders = new Headers(calls[0]!.headers);
    const secondHeaders = new Headers(calls[1]!.headers);
    expect(firstHeaders.get('x-grok-conv-id')).toBe('session-stable-123');
    expect(secondHeaders.get('x-grok-conv-id')).toBe('session-stable-123');
    expect(firstHeaders.get('x-client-test')).toBe('yes');
    expect(JSON.parse(String(calls[0]!.body))).toMatchObject({ tool_choice: 'required' });
    expect(JSON.parse(String(calls[1]!.body))).toMatchObject({ tool_choice: 'auto' });
  });

  it('does not leak Grok affinity or required tool choice to other providers', async () => {
    let captured: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_input, init) => {
      captured = init;
      return doneResponse();
    }) as typeof fetch;
    const provider = openaiCompatibleProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      providerId: 'deepseek',
    });
    await drain(provider, {
      messages: [{ role: 'user', content: 'implement' }],
      model: 'deepseek-v4-pro',
      provider: 'deepseek',
      tools: [{ name: 'mutate', description: 'write', parameters: {} }],
      conversationId: 'same-session',
      generation: { purpose: 'build-recovery', toolChoice: 'required', recoveryAttempt: 1 },
    });

    const headers = new Headers(captured!.headers);
    expect(headers.has('x-grok-conv-id')).toBe(false);
    expect(JSON.parse(String(captured!.body))).toMatchObject({ tool_choice: 'auto' });
  });

  it('serializes provider history in input order and tools canonically', async () => {
    let captured: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_input, init) => {
      captured = init;
      return doneResponse();
    }) as typeof fetch;
    const provider = openaiCompatibleProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.minimax.io/v1',
      model: 'MiniMax-M3',
      providerId: 'minimax',
    });
    await drain(provider, {
      messages: [
        { role: 'system', content: 'stable' },
        { role: 'user', content: 'task' },
        {
          role: 'assistant',
          content: '',
          reasoningContent: 'reason',
          toolCalls: [{ id: 't1', name: 'z_tool', args: { b: 2 } }],
        },
        { role: 'tool', toolCallId: 't1', content: 'result' },
        { role: 'system', content: 'RESOURCE STATUS\nRemaining: 3' },
      ],
      model: 'MiniMax-M3',
      provider: 'minimax',
      tools: [
        { name: 'z_tool', description: 'z', parameters: {} },
        { name: 'a_tool', description: 'a', parameters: {} },
      ],
      conversationId: 'ignored-for-minimax',
    });

    const body = JSON.parse(String(captured!.body)) as {
      messages: Array<Record<string, unknown>>;
      tools: Array<{ function: { name: string } }>;
    };
    expect(body.messages.map((message) => message.role)).toEqual([
      'system', 'user', 'assistant', 'tool', 'system',
    ]);
    expect(body.messages[2]).toMatchObject({ reasoning_content: 'reason' });
    expect(body.tools.map((tool) => tool.function.name)).toEqual(['a_tool', 'z_tool']);
  });
});
