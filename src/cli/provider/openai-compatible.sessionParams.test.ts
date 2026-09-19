import { describe, it, expect, afterEach } from 'vitest';
import { openaiCompatibleProvider } from './openai-compatible.js';
import type { AgentMessage } from '@zelari/core/harness';

/**
 * M3.1 (cache-hit-rate plan): session-frozen wire params.
 *
 * `resolveDeepSeekThinking` used to be re-read from the environment on EVERY
 * provider call and `tool_choice` was rebuilt per call. The prompt cache is
 * keyed on the request prefix, so params that can flip mid-session make every
 * later call a full miss. The contract pinned here: two consecutive calls in
 * the same session differ ONLY in `messages` — the session's happy-path params
 * are resolved once, at provider construction, and reused.
 *
 * The Grok recovery override is the deliberate exception (a model that stopped
 * calling tools cannot finish the turn), so it is asserted separately.
 */

const originalFetch = globalThis.fetch;

type CapturedBody = Record<string, unknown>;

/**
 * Capture every request body the provider POSTs. The SSE body is the minimal
 * `[DONE]` frame — these tests only care about the outgoing request.
 */
function mockFetchCapturingBodies(bodies: CapturedBody[]): void {
  const encoder = new TextEncoder();
  (globalThis as { fetch: unknown }).fetch = async (_input: unknown, init?: RequestInit) => {
    bodies.push(init && typeof init.body === 'string' ? JSON.parse(init.body) : {});
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
}

const TOOLS = [
  {
    name: 'read_file',
    description: 'read a file',
    parameters: { type: 'object', properties: {} },
  },
];

type Provider = ReturnType<typeof openaiCompatibleProvider>;

async function callOnce(
  provider: Provider,
  model: string,
  messages: AgentMessage[],
  generation?: Record<string, unknown>,
): Promise<void> {
  const params = {
    messages,
    model,
    provider: 'test',
    tools: TOOLS,
    ...(generation ? { generation } : {}),
  } as Parameters<Provider>[0];
  for await (const _delta of provider(params)) {
    void _delta;
  }
}

/** The body minus the one field that is supposed to change between calls. */
function withoutMessages(body: CapturedBody): CapturedBody {
  const { messages: _messages, ...rest } = body;
  return rest;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.ZELARI_DEEPSEEK_THINKING;
  delete process.env.ZELARI_DEEPSEEK_REASONING_EFFORT;
});

describe('M3.1 session-frozen DeepSeek thinking params', () => {
  it('makes consecutive calls in one session differ ONLY in messages', async () => {
    const bodies: CapturedBody[] = [];
    mockFetchCapturingBodies(bodies);
    const provider = openaiCompatibleProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      providerId: 'deepseek',
    });

    await callOnce(provider, 'deepseek-v4-pro', [{ role: 'user', content: 'first' }]);
    await callOnce(provider, 'deepseek-v4-pro', [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'second' },
    ]);

    expect(bodies).toHaveLength(2);
    expect(bodies[0].thinking).toEqual({ type: 'enabled' });
    expect(bodies[0].reasoning_effort).toBe('high');
    expect(withoutMessages(bodies[1])).toEqual(withoutMessages(bodies[0]));
  });

  it('freezes the env value at construction: a mid-session flip does not change the body', async () => {
    delete process.env.ZELARI_DEEPSEEK_THINKING;
    const bodies: CapturedBody[] = [];
    mockFetchCapturingBodies(bodies);
    // ONE session (one provider instance) across both calls.
    const provider = openaiCompatibleProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      providerId: 'deepseek',
    });

    await callOnce(provider, 'deepseek-v4-pro', [{ role: 'user', content: 'a' }]);
    // Operator flips the kill switch mid-session — the cache prefix must not
    // silently change under the provider (that was the pre-M3.1 behavior).
    process.env.ZELARI_DEEPSEEK_THINKING = 'off';
    await callOnce(provider, 'deepseek-v4-pro', [{ role: 'user', content: 'b' }]);

    expect(bodies[1].thinking).toEqual({ type: 'enabled' });
    expect(bodies[1].reasoning_effort).toBe('high');
    expect(withoutMessages(bodies[1])).toEqual(withoutMessages(bodies[0]));
  });

  it('samples the env again at the next session boundary (fresh provider instance)', async () => {
    delete process.env.ZELARI_DEEPSEEK_THINKING;
    const bodies: CapturedBody[] = [];
    mockFetchCapturingBodies(bodies);
    const config = {
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      providerId: 'deepseek' as const,
    };

    await callOnce(openaiCompatibleProvider(config), 'deepseek-v4-pro', [
      { role: 'user', content: 'a' },
    ]);
    process.env.ZELARI_DEEPSEEK_THINKING = 'off';
    await callOnce(openaiCompatibleProvider(config), 'deepseek-v4-pro', [
      { role: 'user', content: 'b' },
    ]);

    expect(bodies[0].thinking).toEqual({ type: 'enabled' });
    expect(bodies[1].thinking).toEqual({ type: 'disabled' });
    expect(bodies[1]).not.toHaveProperty('reasoning_effort');
  });
});

describe('M3.1 session-frozen tool_choice (Grok)', () => {
  it('sends the frozen baseline on consecutive calls', async () => {
    const bodies: CapturedBody[] = [];
    mockFetchCapturingBodies(bodies);
    const provider = openaiCompatibleProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.x.ai/v1',
      model: 'grok-4.5',
      providerId: 'grok',
    });

    await callOnce(provider, 'grok-4.5', [{ role: 'user', content: 'a' }]);
    await callOnce(provider, 'grok-4.5', [
      { role: 'user', content: 'a' },
      { role: 'tool', content: 'x', toolCallId: 'tc_1' },
    ]);

    expect(bodies[0].tool_choice).toBe('auto');
    expect(bodies[1].tool_choice).toBe('auto');
    expect(withoutMessages(bodies[1])).toEqual(withoutMessages(bodies[0]));
  });

  it('lets a recovery attempt force tool_choice, then returns to the frozen baseline', async () => {
    const bodies: CapturedBody[] = [];
    mockFetchCapturingBodies(bodies);
    const provider = openaiCompatibleProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.x.ai/v1',
      model: 'grok-4.5',
      providerId: 'grok',
    });

    await callOnce(provider, 'grok-4.5', [{ role: 'user', content: 'a' }]);
    await callOnce(provider, 'grok-4.5', [{ role: 'user', content: 'a' }], {
      toolChoice: 'required',
      recoveryAttempt: 1,
    });
    // Recovery is per-call: the session baseline is NOT mutated by it.
    await callOnce(provider, 'grok-4.5', [{ role: 'user', content: 'a' }]);

    expect(bodies[0].tool_choice).toBe('auto');
    expect(bodies[1].tool_choice).toBe('required');
    expect(bodies[2].tool_choice).toBe('auto');
  });

  it('never forces a tool call on a provider whose profile forbids it', async () => {
    const bodies: CapturedBody[] = [];
    mockFetchCapturingBodies(bodies);
    const provider = openaiCompatibleProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      providerId: 'deepseek',
    });

    await callOnce(provider, 'deepseek-v4-pro', [{ role: 'user', content: 'a' }], {
      toolChoice: 'required',
      recoveryAttempt: 1,
    });

    expect(bodies[0].tool_choice).toBe('auto');
  });
});
