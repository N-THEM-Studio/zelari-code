import { describe, it, expect, afterEach } from 'vitest';
import { anthropicMessagesProvider } from '../../src/cli/provider/anthropic.js';

/**
 * Anthropic explicit prompt caching (v1.35).
 *
 * The OpenAI-compatible path relies on automatic server-side prefix
 * caching; the Anthropic path must instead send `cache_control`
 * breakpoints. These tests pin the request-body construction (stable
 * system boundary + rolling conversation breakpoint) and the folding of
 * Anthropic's split cache-usage fields into the provider-neutral usage
 * delta.
 */

interface FetchMock {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

const originalFetch = globalThis.fetch;
let capturedInit: RequestInit | undefined;

function mockFetchWithSseChunks(chunks: string[]): void {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  const response = new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
  (globalThis as { fetch: FetchMock }).fetch = async (_input, init) => {
    capturedInit = init;
    return response;
  };
}

function makeProvider() {
  return anthropicMessagesProvider({
    apiKey: 'sk-ant-test',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-test',
    providerId: 'anthropic',
  });
}

function lastBody(): Record<string, unknown> {
  return JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  capturedInit = undefined;
  delete process.env.ZELARI_PROMPT_CACHE_TTL;
});

describe('anthropicMessagesProvider — cache_control breakpoints', () => {
  it('puts the breakpoint on the stable system block, not the volatile one', async () => {
    mockFetchWithSseChunks(['data: [DONE]\n\n']);
    const provider = makeProvider();
    for await (const _d of provider({
      messages: [
        { role: 'system', content: 'STABLE PROMPT' },
        { role: 'system', content: 'VOLATILE WORKSPACE STATE' },
        { role: 'user', content: 'hello' },
      ],
      model: 'claude-test',
      provider: 'anthropic',
      tools: [],
    })) {
      void _d;
    }
    const body = lastBody();
    expect(body.system).toEqual([
      { type: 'text', text: 'STABLE PROMPT', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'VOLATILE WORKSPACE STATE' },
    ]);
  });

  it('breakpoints the only system block when there is no volatile part', async () => {
    mockFetchWithSseChunks(['data: [DONE]\n\n']);
    const provider = makeProvider();
    for await (const _d of provider({
      messages: [
        { role: 'system', content: 'STABLE ONLY' },
        { role: 'user', content: 'hello' },
      ],
      model: 'claude-test',
      provider: 'anthropic',
      tools: [],
    })) {
      void _d;
    }
    const body = lastBody();
    expect(body.system).toEqual([
      { type: 'text', text: 'STABLE ONLY', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('puts the rolling breakpoint on the last conversation message', async () => {
    mockFetchWithSseChunks(['data: [DONE]\n\n']);
    const provider = makeProvider();
    for await (const _d of provider({
      messages: [
        { role: 'system', content: 'STABLE' },
        { role: 'user', content: 'hello' },
      ],
      model: 'claude-test',
      provider: 'anthropic',
      tools: [],
    })) {
      void _d;
    }
    const body = lastBody();
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }],
    });
  });

  it('breakpoints the last tool_use block of a trailing assistant message', async () => {
    mockFetchWithSseChunks(['data: [DONE]\n\n']);
    const provider = makeProvider();
    for await (const _d of provider({
      messages: [
        { role: 'system', content: 'STABLE' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tu_1', name: 'read_file', args: { path: '/tmp/x' } }],
        },
      ],
      model: 'claude-test',
      provider: 'anthropic',
      tools: [],
    })) {
      void _d;
    }
    const body = lastBody();
    const messages = body.messages as Array<Record<string, unknown>>;
    const blocks = messages[0]!.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: 'tool_use',
      id: 'tu_1',
      name: 'read_file',
      input: { path: '/tmp/x' },
      cache_control: { type: 'ephemeral' },
    });
  });

  it('uses ttl 1h + the extended-cache beta header when ZELARI_PROMPT_CACHE_TTL=1h', async () => {
    process.env.ZELARI_PROMPT_CACHE_TTL = '1h';
    mockFetchWithSseChunks(['data: [DONE]\n\n']);
    const provider = makeProvider();
    for await (const _d of provider({
      messages: [
        { role: 'system', content: 'STABLE' },
        { role: 'user', content: 'hello' },
      ],
      model: 'claude-test',
      provider: 'anthropic',
      tools: [],
    })) {
      void _d;
    }
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers['anthropic-beta']).toContain('extended-cache-ttl-2025-04-11');
    const body = lastBody();
    const system = body.system as Array<Record<string, unknown>>;
    expect(system[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('keeps tool messages without a breakpoint when they are not last', async () => {
    mockFetchWithSseChunks(['data: [DONE]\n\n']);
    const provider = makeProvider();
    for await (const _d of provider({
      messages: [
        { role: 'system', content: 'STABLE' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tu_1', name: 'read_file', args: { path: '/tmp/x' } }],
        },
        { role: 'tool', toolCallId: 'tu_1', content: 'file body' },
        { role: 'user', content: 'thanks' },
      ],
      model: 'claude-test',
      provider: 'anthropic',
      tools: [],
    })) {
      void _d;
    }
    const body = lastBody();
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(3);
    const toolBlocks = messages[1]!.content as Array<Record<string, unknown>>;
    expect(toolBlocks[0]!.cache_control).toBeUndefined();
    const lastBlocks = messages[2]!.content as Array<Record<string, unknown>>;
    expect(lastBlocks[0]!.cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('anthropicMessagesProvider — cache-aware usage', () => {
  it('folds message_start cache fields into the usage delta', async () => {
    mockFetchWithSseChunks([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":5000,"cache_creation_input_tokens":2000}}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}\n\n',
    ]);
    const provider = makeProvider();
    let usageDelta:
      | { promptTokens: number; completionTokens: number; totalTokens: number; cachedPromptTokens?: number }
      | undefined;
    for await (const d of provider({
      messages: [{ role: 'user', content: 'hello' }],
      model: 'claude-test',
      provider: 'anthropic',
      tools: [],
    })) {
      if (d.kind === 'usage' && d.usage) usageDelta = d.usage;
    }
    // prompt = uncached input (100) + cache read (5000) + cache creation (2000)
    expect(usageDelta).toEqual({
      promptTokens: 7100,
      completionTokens: 50,
      totalTokens: 7150,
      cachedPromptTokens: 5000,
    });
  });

  it('reports usage without cache fields when the provider sends none', async () => {
    mockFetchWithSseChunks([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":42}}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
    ]);
    const provider = makeProvider();
    let usageDelta:
      | { promptTokens: number; completionTokens: number; totalTokens: number; cachedPromptTokens?: number }
      | undefined;
    for await (const d of provider({
      messages: [{ role: 'user', content: 'hello' }],
      model: 'claude-test',
      provider: 'anthropic',
      tools: [],
    })) {
      if (d.kind === 'usage' && d.usage) usageDelta = d.usage;
    }
    expect(usageDelta).toEqual({ promptTokens: 42, completionTokens: 7, totalTokens: 49 });
  });
});
