import { describe, it, expect, afterEach } from 'vitest';
import { anthropicMessagesProvider } from '../../src/cli/provider/anthropic.js';

/**
 * Anthropic explicit prompt caching (v1.35).
 *
 * The OpenAI-compatible path relies on automatic server-side prefix
 * caching; the Anthropic path must instead send `cache_control`
 * breakpoints. These tests pin the request-body construction (stable
 * system boundary + transcript boundary + rolling tail) and the folding of
 * Anthropic's split cache-usage fields into the provider-neutral usage
 * delta.
 *
 * M2.1/M2.2 (cache-hit-rate plan): the default request layout is
 * `[stable system][history][<context-update>…volatile…][new turn]`, so the
 * provider has to place its second breakpoint on the EPHEMERAL trailing
 * message (end of the stable transcript) instead of only on the last
 * message. The pre-M2 `[stable, volatile system][history][new turn]` shape is
 * covered too, as the `ZELARI_PROMPT_LAYOUT=legacy` rollback regression.
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

/** Count the `cache_control` markers in a request body (Anthropic allows 4). */
function countBreakpoints(body: Record<string, unknown>): number {
  return JSON.stringify(body).split('"cache_control"').length - 1;
}

/** Cache-control marker of block 0 of a wire message (undefined when absent). */
function firstBlockCacheControl(msg: Record<string, unknown> | undefined): unknown {
  const content = msg?.content;
  if (!Array.isArray(content)) return undefined;
  return (content[0] as Record<string, unknown> | undefined)?.cache_control;
}

/** The M2.1 ephemeral trailing-context message (only data, zero instructions). */
function trailingContextMessage(volatile: string): { role: 'user'; content: string } {
  return { role: 'user', content: `<context-update>\n${volatile}\n</context-update>` };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  capturedInit = undefined;
  delete process.env.ZELARI_PROMPT_CACHE_TTL;
});

describe('anthropicMessagesProvider — cache_control breakpoints', () => {
  it('legacy rollback shape [stable, volatile]: breakpoint on stable, not on volatile', async () => {
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
    // Pre-M2 pair preserved: system boundary + rolling last message. With two
    // system blocks the STABLE one is the penultimate (index 0 here).
    expect(countBreakpoints(body)).toBe(2);
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

  it('M2.1 layout: bp on stable system + trailing context + rolling tail (3 of 4)', async () => {
    mockFetchWithSseChunks(['data: [DONE]\n\n']);
    const provider = makeProvider();
    for await (const _d of provider({
      messages: [
        { role: 'system', content: 'STABLE PROMPT' },
        { role: 'user', content: 'turn-1 question' },
        { role: 'assistant', content: 'turn-1 answer' },
        trailingContextMessage('WORKSPACE V2'),
        { role: 'user', content: 'turn-2 question' },
      ],
      model: 'claude-test',
      provider: 'anthropic',
      tools: [],
    })) {
      void _d;
    }
    const body = lastBody();
    // bp1: the single (stable-only) system block — tools + stable prefix.
    expect(body.system).toEqual([
      { type: 'text', text: 'STABLE PROMPT', cache_control: { type: 'ephemeral' } },
    ]);
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(4);
    // History stays breakpoint-free: only its stable end is pinned…
    expect(firstBlockCacheControl(messages[0])).toBeUndefined();
    expect(messages[0]).toEqual({ role: 'user', content: 'turn-1 question' });
    expect(firstBlockCacheControl(messages[1])).toBeUndefined();
    expect(messages[1]).toEqual({ role: 'assistant', content: 'turn-1 answer' });
    // …bp2 = end of the stable transcript, i.e. the trailing context…
    expect(firstBlockCacheControl(messages[2])).toEqual({ type: 'ephemeral' });
    expect((messages[2]!.content as Array<{ text: string }>)[0]!.text).toBe(
      '<context-update>\nWORKSPACE V2\n</context-update>',
    );
    // …bp3 = rolling tail over the new turn.
    expect(firstBlockCacheControl(messages[3])).toEqual({ type: 'ephemeral' });
    // Budget: 3 of the 4 breakpoints Anthropic allows (max 4 constraint).
    expect(countBreakpoints(body)).toBe(3);
  });

  it('M2.1 layout: keeps the trailing breakpoint while a tool loop extends the tail', async () => {
    mockFetchWithSseChunks(['data: [DONE]\n\n']);
    const provider = makeProvider();
    for await (const _d of provider({
      messages: [
        { role: 'system', content: 'STABLE PROMPT' },
        { role: 'user', content: 'turn-1 question' },
        trailingContextMessage('WORKSPACE V2'),
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tu_1', name: 'read_file', args: { path: '/tmp/x' } }],
        },
        { role: 'tool', toolCallId: 'tu_1', content: 'file body' },
      ],
      model: 'claude-test',
      provider: 'anthropic',
      tools: [],
    })) {
      void _d;
    }
    const body = lastBody();
    const messages = body.messages as Array<Record<string, unknown>>;
    // [user t1][trailing][assistant tool_use][tool_result]
    expect(messages).toHaveLength(4);
    // The transcript boundary stays pinned to the trailing message even though
    // the tool loop appended messages after it…
    expect(firstBlockCacheControl(messages[1])).toEqual({ type: 'ephemeral' });
    // …and the rolling tail moved with the appended blocks.
    expect(firstBlockCacheControl(messages[2])).toBeUndefined();
    expect((messages[3]!.content as Array<Record<string, unknown>>)[0]!.cache_control).toEqual({
      type: 'ephemeral',
    });
    expect(countBreakpoints(body)).toBe(3);
  });

  it('M2.1 layout: a user turn merely mentioning the tag is NOT a trailing context', async () => {
    mockFetchWithSseChunks(['data: [DONE]\n\n']);
    const provider = makeProvider();
    for await (const _d of provider({
      messages: [
        { role: 'system', content: 'STABLE PROMPT' },
        { role: 'user', content: 'see the <context-update> block' },
        { role: 'assistant', content: 'noted' },
        { role: 'user', content: 'next' },
      ],
      model: 'claude-test',
      provider: 'anthropic',
      tools: [],
    })) {
      void _d;
    }
    const body = lastBody();
    const messages = body.messages as Array<Record<string, unknown>>;
    // No tag-shaped message ⇒ exactly the pre-M2 pair: system + last message.
    expect(countBreakpoints(body)).toBe(2);
    expect(firstBlockCacheControl(messages[0])).toBeUndefined();
    expect(firstBlockCacheControl(messages[1])).toBeUndefined();
    expect(firstBlockCacheControl(messages[2])).toEqual({ type: 'ephemeral' });
  });

  it('applies the 1h TTL to every M2.1 breakpoint (system + trailing + tail)', async () => {
    process.env.ZELARI_PROMPT_CACHE_TTL = '1h';
    mockFetchWithSseChunks(['data: [DONE]\n\n']);
    const provider = makeProvider();
    for await (const _d of provider({
      messages: [
        { role: 'system', content: 'STABLE PROMPT' },
        { role: 'user', content: 'turn-1 question' },
        trailingContextMessage('WORKSPACE V2'),
        { role: 'user', content: 'turn-2 question' },
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
    const messages = body.messages as Array<Record<string, unknown>>;
    // [user t1][trailing][user t2] — both conversational breakpoints carry the TTL.
    expect(firstBlockCacheControl(messages[1])).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(firstBlockCacheControl(messages[2])).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(countBreakpoints(body)).toBe(3);
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
