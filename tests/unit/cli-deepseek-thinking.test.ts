import { describe, it, expect, afterEach } from 'vitest';
import { openaiCompatibleProvider } from '../../src/cli/provider/openai-compatible.js';
import type { AgentMessage } from '@zelari/core/harness';

/**
 * DeepSeek thinking-mode wire options (v4) — P0 token-cache work.
 *
 * Two independent behaviors under test:
 *   1. `thinking` / `reasoning_effort` are sent only for the `deepseek`
 *      provider (default ON + high; kill switch via ZELARI_DEEPSEEK_THINKING).
 *   2. `reasoning_content` passback: kept on tool-call turns (required by
 *      DeepSeek, else HTTP 400), dropped on plain text turns (ignored by the
 *      API but still billed — dsh `serialize` does the same).
 */

const originalFetch = globalThis.fetch;

type FetchMock = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function mockFetchCapturingBody(captured: { body: Record<string, unknown> | null }): void {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  const response = new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
  (globalThis as { fetch: FetchMock }).fetch = async (_input, init) => {
    captured.body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    return response;
  };
}

async function runOnce(providerId: string, messages: AgentMessage[]): Promise<Record<string, unknown> | null> {
  const captured: { body: Record<string, unknown> | null } = { body: null };
  mockFetchCapturingBody(captured);
  const provider = openaiCompatibleProvider({
    apiKey: 'sk-test',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    providerId: providerId as never,
  });
  for await (const _ of provider({ messages, model: 'deepseek-v4-pro', provider: providerId, tools: [] })) {
    /* drain */
  }
  return captured.body;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.ZELARI_DEEPSEEK_THINKING;
  delete process.env.ZELARI_DEEPSEEK_REASONING_EFFORT;
});

describe('DeepSeek thinking-mode wire options', () => {
  it('sends thinking enabled + reasoning_effort high by default', async () => {
    const body = await runOnce('deepseek', []);
    expect(body).not.toBeNull();
    expect(body!.thinking).toEqual({ type: 'enabled' });
    expect(body!.reasoning_effort).toBe('high');
  });

  it('honors ZELARI_DEEPSEEK_REASONING_EFFORT=max', async () => {
    process.env.ZELARI_DEEPSEEK_REASONING_EFFORT = 'max';
    const body = await runOnce('deepseek', []);
    expect(body!.reasoning_effort).toBe('max');
    expect(body!.thinking).toEqual({ type: 'enabled' });
  });

  it('disables thinking via ZELARI_DEEPSEEK_THINKING=off (no reasoning_effort on wire)', async () => {
    process.env.ZELARI_DEEPSEEK_THINKING = 'off';
    const body = await runOnce('deepseek', []);
    expect(body!.thinking).toEqual({ type: 'disabled' });
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('does not send thinking for non-deepseek providers', async () => {
    const body = await runOnce('openai-compatible', []);
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('reasoning_effort');
  });
});

describe('DeepSeek reasoning_content passback', () => {
  it('drops reasoning_content on plain text assistant turns', async () => {
    const body = await runOnce('deepseek', [
      { role: 'assistant', content: 'hello there', reasoningContent: 'secret chain of thought' },
    ]);
    const messages = body!.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ role: 'assistant', content: 'hello there' });
    expect(messages[0]).not.toHaveProperty('reasoning_content');
  });

  it('keeps reasoning_content on tool-call assistant turns', async () => {
    const body = await runOnce('deepseek', [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc_1', name: 'read_file', args: { path: '/tmp/x' } }],
        reasoningContent: 'I should read the file first',
      },
    ]);
    const messages = body!.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toHaveProperty('reasoning_content', 'I should read the file first');
    expect(messages[0]).toHaveProperty('tool_calls');
  });
});
