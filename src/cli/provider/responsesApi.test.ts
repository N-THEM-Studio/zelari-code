/**
 * Tests for the selectable Responses API endpoint (`/provider api responses`)
 * and the 'max' effort on openai-compatible providers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentMessage, ProviderDelta } from '@zelari/core/harness';
import { responsesApiProvider } from './responsesApi.js';
import { buildProviderStream } from './resolveStream.js';
import { effortLevelsFor } from '../thinkingCapability.js';
import { translateResponsesThinking } from '../thinking.js';
import { getApiStyleFor, setApiStyleFor, getProviderConfig } from '../providerConfig.js';

const CONFIG = {
  apiKey: 'test-key',
  baseUrl: 'https://api.test/v1',
  model: 'test-model',
  providerId: 'openai-compatible' as const,
};

function sse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}`).join('\n') + '\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collect(stream: AsyncIterable<ProviderDelta>): Promise<ProviderDelta[]> {
  const out: ProviderDelta[] = [];
  for await (const d of stream) out.push(d);
  return out;
}

const MESSAGES: AgentMessage[] = [
  { role: 'system', content: 'You are helpful.' } as AgentMessage,
  { role: 'user', content: 'hi' } as AgentMessage,
];

function callParams() {
  return { messages: MESSAGES, model: 'test-model', tools: [] } as never;
}

let tmpConfigFile: string;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  tmpConfigFile = path.join(os.tmpdir(), `zelari-provider-test-${process.pid}-${Date.now()}.json`);
  process.env.ANATHEMA_PROVIDER_CONFIG_FILE = tmpConfigFile;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.ANATHEMA_PROVIDER_CONFIG_FILE;
  await fs.rm(tmpConfigFile, { force: true });
});

describe('responsesApiProvider transport', () => {
  it('posts to /responses with instructions + emits text/usage/finish', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      sse([
        { type: 'response.output_text.delta', delta: 'Hello' },
        { type: 'response.reasoning_text.delta', delta: 'thinking...' },
        { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } },
      ]),
    );
    const deltas = await collect(responsesApiProvider(CONFIG)(callParams()));

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/v1/responses');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(body.model).toBe('test-model');
    expect(body.instructions).toBe('You are helpful.');
    expect(body.stream).toBe(true);
    expect(typeof body.temperature).toBe('number');
    expect(body.input).toEqual([{ role: 'user', content: 'hi' }]);

    expect(deltas.some((d) => d.kind === 'text' && d.delta === 'Hello')).toBe(true);
    expect(deltas.some((d) => d.kind === 'thinking' && d.delta === 'thinking...')).toBe(true);
    const usage = deltas.find((d) => d.kind === 'usage');
    expect(usage && 'usage' in usage ? usage.usage : null).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
    expect(deltas.at(-1)).toEqual({ kind: 'finish', reason: 'stop' });
  });

  it('maps a streamed function_call to a tool_call delta', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      sse([
        { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '' } },
        { type: 'response.function_call_arguments.delta', item_id: 'call-1', delta: '{"path":"a.ts"}' },
        { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call-1' } },
        { type: 'response.completed', response: {} },
      ]),
    );
    const deltas = await collect(responsesApiProvider(CONFIG)(callParams()));
    expect(deltas).toContainEqual({
      kind: 'tool_call',
      toolCallId: 'call-1',
      toolName: 'read_file',
      args: { path: 'a.ts' },
    });
    expect(deltas.at(-1)).toEqual({ kind: 'finish', reason: 'tool_calls' });
  });

  it('surfaces HTTP errors visibly', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('nope', { status: 400 }));
    const deltas = await collect(responsesApiProvider(CONFIG)(callParams()));
    const err = deltas.find((d) => d.kind === 'error');
    expect(err && 'message' in err ? err.message : '').toContain('HTTP 400');
  });

  it('retries a 429 and succeeds on the second attempt', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(sse([{ type: 'response.completed', response: {} }]));
    const deltas = await collect(responsesApiProvider(CONFIG)(callParams()));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(deltas.at(-1)).toEqual({ kind: 'finish', reason: 'stop' });
  });
});

describe('apiStyle routing (resolveStream + providerConfig)', () => {
  it('routes to /responses when the style is responses, /chat/completions otherwise', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(sse([{ type: 'response.completed', response: {} }]))
      .mockResolvedValueOnce(
        new Response(
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      );

    setApiStyleFor('openai-compatible', 'responses');
    expect(getApiStyleFor('openai-compatible')).toBe('responses');
    await collect(buildProviderStream(CONFIG)(callParams()));
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/v1/responses');

    setApiStyleFor('openai-compatible', 'chat');
    expect(getApiStyleFor('openai-compatible')).toBe('chat');
    await collect(buildProviderStream(CONFIG)(callParams()));
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.test/v1/chat/completions');
  });

  it('persists, sanitizes and roundtrips apiStyleByProvider', async () => {
    expect(getApiStyleFor('grok')).toBe('chat'); // default when absent
    setApiStyleFor('grok', 'responses');
    expect(getProviderConfig().apiStyleByProvider?.grok).toBe('responses');
    // Corrupt/unknown entries are dropped by the merge on reload.
    await fs.writeFile(
      tmpConfigFile,
      JSON.stringify({
        activeProviderId: 'openai-compatible',
        modelByProvider: {},
        apiStyleByProvider: { 'openai-compatible': 'responses', bogus: 'responses', grok: 'nope' },
      }),
      'utf-8',
    );
    expect(getApiStyleFor('openai-compatible')).toBe('responses');
    expect(getApiStyleFor('grok')).toBe('chat');
    expect(() => setApiStyleFor('openai-compatible', 'bogus' as never)).toThrow();
  });
});

describe('max effort on openai-compatible', () => {
  it('exposes the full native ladder (xhigh, max) on user-pointed endpoints', () => {
    expect(effortLevelsFor('openai-compatible', 'whatever')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(effortLevelsFor('custom')).toContain('max');
    // grok keeps model gating: no 'max' even on grok-4.6.
    expect(effortLevelsFor('grok', 'grok-4.6')).not.toContain('max');
  });

  it('sends reasoning.effort max unclamped on /responses for openai-compatible', () => {
    const t = translateResponsesThinking({ kind: 'effort', effort: 'max' }, 'test-model', 'openai-compatible');
    expect(t.degraded).toBe(false);
    expect(t.patch).toEqual({ reasoning: { effort: 'max' } });
  });

  it('still clamps on chatgpt models without max (unchanged behavior)', () => {
    const t = translateResponsesThinking({ kind: 'effort', effort: 'max' }, 'gpt-5');
    expect(t.patch).toEqual({ reasoning: { effort: 'high' } });
    expect(t.note).toBeTruthy();
  });
});
