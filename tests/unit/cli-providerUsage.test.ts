/**
 * cli-providerUsage.test.ts — Tasks G.4.1 + G.4.2
 *
 * Verifies the OpenAI-compatible provider correctly emits a `usage`
 * `ProviderDelta` when the SSE chunk includes an OpenAI-shaped
 * `usage` payload. Also verifies that `stream_options.include_usage`
 * is added to the request body (so providers that gate the usage
 * chunk behind that flag actually send it).
 */

import { describe, it, expect } from 'vitest';
import { openaiCompatibleProvider } from '../../src/cli/provider/openai-compatible.js';
import { collectDeltas } from '../../src/cli/providerFailover.js';
import type { ProviderDelta } from '@zelari/core/harness';

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeFetchSpy(responseBody: string): { fetchSpy: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchSpy = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(responseBody));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch;
  return { fetchSpy, calls };
}

describe('openai-compatible provider emits usage delta (Task G.4.2)', () => {
  it('request body includes stream_options.include_usage=true', async () => {
    const responseBody = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      '',
      'data: {"choices":[{"delta":{}],"finish_reason":"stop"}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const { fetchSpy, calls } = makeFetchSpy(responseBody);
    const saved = globalThis.fetch;
    globalThis.fetch = fetchSpy;
    try {
      const provider = openaiCompatibleProvider({
        apiKey: 'sk-test',
        baseUrl: 'https://example.com/v1',
        model: 'test-model',
        providerId: 'openai-compatible',
      });
      await collectDeltas(provider, {
        messages: [{ role: 'user', content: 'hello' }],
        model: 'test-model',
        provider: 'openai-compatible',
        tools: [],
      });
      expect(calls.length).toBe(1);
      const body = JSON.parse(calls[0]?.init.body as string) as {
        stream_options?: { include_usage?: boolean };
      };
      expect(body.stream_options).toEqual({ include_usage: true });
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('emits a `usage` ProviderDelta when chunk carries usage payload', async () => {
    // OpenAI-style: usage arrives on the chunk whose choices array may be
    // empty (only the usage field is populated).
    const textChunk = JSON.stringify({ choices: [{ delta: { content: 'hi' } }] });
    const usageChunk = JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
    });
    const responseBody = [
      `data: ${textChunk}`,
      '',
      `data: ${usageChunk}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const { fetchSpy } = makeFetchSpy(responseBody);
    const saved = globalThis.fetch;
    globalThis.fetch = fetchSpy;
    try {
      const provider = openaiCompatibleProvider({
        apiKey: 'sk-test',
        baseUrl: 'https://example.com/v1',
        model: 'test-model',
        providerId: 'openai-compatible',
      });
      const deltas: ProviderDelta[] = await collectDeltas(provider, {
        messages: [{ role: 'user', content: 'hello' }],
        model: 'test-model',
        provider: 'openai-compatible',
        tools: [],
      });
      const usageDeltas = deltas.filter((d) => d.kind === 'usage');
      expect(usageDeltas.length).toBe(1);
      const usageDelta = usageDeltas[0];
      if (usageDelta && usageDelta.kind === 'usage') {
        expect(usageDelta.usage.promptTokens).toBe(42);
        expect(usageDelta.usage.completionTokens).toBe(7);
        expect(usageDelta.usage.totalTokens).toBe(49);
      }
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('handles missing total_tokens by summing prompt + completion', async () => {
    const responseBody = [
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const { fetchSpy } = makeFetchSpy(responseBody);
    const saved = globalThis.fetch;
    globalThis.fetch = fetchSpy;
    try {
      const provider = openaiCompatibleProvider({
        apiKey: 'sk-test',
        baseUrl: 'https://example.com/v1',
        model: 'test-model',
        providerId: 'openai-compatible',
      });
      const deltas: ProviderDelta[] = await collectDeltas(provider, {
        messages: [{ role: 'user', content: 'hello' }],
        model: 'test-model',
        provider: 'openai-compatible',
        tools: [],
      });
      const usageDelta = deltas.find((d) => d.kind === 'usage');
      if (usageDelta && usageDelta.kind === 'usage') {
        expect(usageDelta.usage.promptTokens).toBe(10);
        expect(usageDelta.usage.completionTokens).toBe(5);
        expect(usageDelta.usage.totalTokens).toBe(15); // sum fallback
      } else {
        expect.fail('Expected a usage delta');
      }
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('no usage delta when provider omits usage field (graceful degradation)', async () => {
    const responseBody = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      '',
      'data: {"choices":[{"delta":{}],"finish_reason":"stop"}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const { fetchSpy } = makeFetchSpy(responseBody);
    const saved = globalThis.fetch;
    globalThis.fetch = fetchSpy;
    try {
      const provider = openaiCompatibleProvider({
        apiKey: 'sk-test',
        baseUrl: 'https://example.com/v1',
        model: 'test-model',
        providerId: 'openai-compatible',
      });
      const deltas: ProviderDelta[] = await collectDeltas(provider, {
        messages: [{ role: 'user', content: 'hello' }],
        model: 'test-model',
        provider: 'openai-compatible',
        tools: [],
      });
      const usageDeltas = deltas.filter((d) => d.kind === 'usage');
      expect(usageDeltas.length).toBe(0);
    } finally {
      globalThis.fetch = saved;
    }
  });
});
