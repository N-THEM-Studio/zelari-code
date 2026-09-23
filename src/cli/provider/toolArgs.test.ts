import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderDelta } from '@zelari/core/harness';
import {
  formatToolArgsParseError,
  parseToolArgsJson,
  TOOL_ARGS_EXCERPT_LIMIT,
  TOOL_ARGS_PARSE_FAILED_CODE,
  type ToolArgsParseError,
} from './toolArgs.js';
import { openaiCompatibleProvider, type OpenAICompatibleConfig } from './openai-compatible.js';
import { anthropicMessagesProvider } from './anthropic.js';
import { chatgptResponsesProvider } from './chatgpt.js';
import { responsesApiProvider } from './responsesApi.js';

/**
 * K4.1 / plan F22+F23 "no silent model-channel degradation".
 *
 * Malformed tool-call args JSON used to degrade silently: anthropic /
 * chatgpt / responsesApi fell back to `args = {}`, openai-compatible dropped
 * the call with `if (args === null) continue`. The contract pinned here:
 * every parse failure becomes a typed error carrying the guard code
 * `tool_args_parse_failed`, the tool-call id and a truncated (~200 chars)
 * excerpt of the payload, surfaced through each adapter's existing
 * `{ kind: 'error' }` delta. Valid JSON keeps byte-identical args.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type Provider = ReturnType<typeof openaiCompatibleProvider>;
type StreamParams = Parameters<Provider>[0];

const params = {
  messages: [],
  model: 'test-model',
  provider: 'test',
  tools: [],
} as StreamParams;

function config(providerId: OpenAICompatibleConfig['providerId']): OpenAICompatibleConfig {
  return { apiKey: 'test-key', baseUrl: 'https://provider.test/v1', model: 'test-model', providerId };
}

/** Stub fetch with one SSE response made of `data: <frame>` lines. */
function stubSseFetch(frames: string[]): void {
  const encoder = new TextEncoder();
  (globalThis as { fetch: unknown }).fetch = async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
}

async function collect(gen: AsyncIterable<ProviderDelta>): Promise<ProviderDelta[]> {
  const deltas: ProviderDelta[] = [];
  for await (const d of gen) deltas.push(d);
  return deltas;
}

function errorDeltas(deltas: ProviderDelta[]): Array<Extract<ProviderDelta, { kind: 'error' }>> {
  return deltas.filter((d): d is Extract<ProviderDelta, { kind: 'error' }> => d.kind === 'error');
}

function toolCallDeltas(
  deltas: ProviderDelta[],
): Array<Extract<ProviderDelta, { kind: 'tool_call' }>> {
  return deltas.filter(
    (d): d is Extract<ProviderDelta, { kind: 'tool_call' }> => d.kind === 'tool_call',
  );
}

/** OpenAI-compatible chunk carrying one tool_call args fragment. */
function toolCallChunk(index: number, id: string, name: string, argsFragment: string): string {
  return JSON.stringify({
    choices: [
      { delta: { tool_calls: [{ index, id, function: { name, arguments: argsFragment } }] } },
    ],
  });
}

const FINISH_TOOL_CALLS = JSON.stringify({
  choices: [{ delta: {}, finish_reason: 'tool_calls' }],
});

describe('parseToolArgsJson — tool_args_parse_failed guard (K4.1)', () => {
  it('malformed JSON → typed error with guard code, tool-call id and excerpt', () => {
    const result = parseToolArgsJson('{"path": ', 'call_1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('tool_args_parse_failed');
    expect(TOOL_ARGS_PARSE_FAILED_CODE).toBe('tool_args_parse_failed');
    expect(result.error.toolCallId).toBe('call_1');
    expect(result.error.detail).toBe('is not valid JSON');
    expect(result.error.excerpt).toBe('{"path":');
    const message = formatToolArgsParseError(result.error);
    expect(message).toContain('tool_args_parse_failed');
    expect(message).toContain('call_1');
    expect(message).toContain('{"path":');
  });

  it('non-object JSON ("str", [], null, 42) → same typed error', () => {
    for (const payload of ['"str"', '[]', 'null', '42']) {
      const result = parseToolArgsJson(payload, 'call_x');
      expect(result.ok, payload).toBe(false);
      if (result.ok) continue;
      expect(result.error.code, payload).toBe('tool_args_parse_failed');
      expect(result.error.toolCallId, payload).toBe('call_x');
      expect(result.error.detail, payload).toBe('is not a JSON object');
      expect(result.error.excerpt, payload).toBe(payload);
    }
  });

  it('excerpt truncates long payloads to ~200 chars', () => {
    const result = parseToolArgsJson(`{${'x'.repeat(500)}`, 'call_long');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const error: ToolArgsParseError = result.error;
    expect(error.excerpt.length).toBe(TOOL_ARGS_EXCERPT_LIMIT + 1);
    expect(error.excerpt.endsWith('…')).toBe(true);
    expect(error.excerpt.startsWith(`{${'x'.repeat(10)}`)).toBe(true);
  });

  it('valid JSON object → args unchanged (byte-identical parse)', () => {
    const raw = '{"path":"a.ts","opts":{"n":1,"xs":[1,2]}}';
    const result = parseToolArgsJson(raw, 'call_ok');
    expect(result).toEqual({
      ok: true,
      args: { path: 'a.ts', opts: { n: 1, xs: [1, 2] } },
    });
    if (!result.ok) return;
    expect(JSON.stringify(result.args)).toBe(raw);
  });

  it('empty / whitespace args keep the zero-arg `{}` success', () => {
    expect(parseToolArgsJson('', 'call_zero')).toEqual({ ok: true, args: {} });
    expect(parseToolArgsJson('   ', 'call_zero')).toEqual({ ok: true, args: {} });
    expect(parseToolArgsJson('{}', 'call_zero')).toEqual({ ok: true, args: {} });
  });
});

describe('openai-compatible flushToolAccumulator — synthetic error per tool-call id', () => {
  it('emits a synthetic tool_args_parse_failed error per incomplete tool call, dropping none silently', async () => {
    stubSseFetch([
      toolCallChunk(0, 'call_a', 'read_file', '{"path": '),
      toolCallChunk(1, 'call_b', 'write_file', '[1,2'),
      FINISH_TOOL_CALLS,
      '[DONE]',
    ]);
    const deltas = await collect(openaiCompatibleProvider(config('openai-compatible'))(params));

    expect(toolCallDeltas(deltas)).toHaveLength(0);
    const errors = errorDeltas(deltas);
    expect(errors).toHaveLength(2);
    expect(errors[0]!.message).toContain('tool_args_parse_failed');
    expect(errors[0]!.message).toContain('call_a');
    expect(errors[0]!.message).toContain('{"path":');
    expect(errors[1]!.message).toContain('tool_args_parse_failed');
    expect(errors[1]!.message).toContain('call_b');
    expect(errors[1]!.message).toContain('[1,2');
  });

  it('a malformed sibling does not suppress the valid call (byte-identical args)', async () => {
    stubSseFetch([
      toolCallChunk(0, 'call_ok', 'read_file', '{"path":"a.ts"}'),
      toolCallChunk(1, 'call_bad', 'write_file', 'oops'),
      FINISH_TOOL_CALLS,
      '[DONE]',
    ]);
    const deltas = await collect(openaiCompatibleProvider(config('openai-compatible'))(params));

    const calls = toolCallDeltas(deltas);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolCallId).toBe('call_ok');
    expect(JSON.stringify(calls[0]!.args)).toBe('{"path":"a.ts"}');
    const errors = errorDeltas(deltas);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('tool_args_parse_failed');
    expect(errors[0]!.message).toContain('call_bad');
  });

  it('regression: valid and zero-arg calls still emit identical args with no error', async () => {
    stubSseFetch([
      toolCallChunk(0, 'call_frag', 'read_file', '{"pa'),
      toolCallChunk(0, 'call_frag', 'read_file', 'th":"a.ts"}'),
      toolCallChunk(1, 'call_zero', 'think', ''),
      FINISH_TOOL_CALLS,
      '[DONE]',
    ]);
    const deltas = await collect(openaiCompatibleProvider(config('openai-compatible'))(params));

    expect(errorDeltas(deltas)).toHaveLength(0);
    const calls = toolCallDeltas(deltas);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.toolCallId).toBe('call_frag');
    expect(JSON.stringify(calls[0]!.args)).toBe('{"path":"a.ts"}');
    expect(calls[1]!.toolCallId).toBe('call_zero');
    expect(calls[1]!.args).toEqual({});
  });
});

describe('anthropic / chatgpt / responsesApi flush — malformed args surface as typed error', () => {
  it('anthropic: malformed input_json_delta → error with code + id + excerpt, no degraded tool_call', async () => {
    stubSseFetch([
      JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_1', name: 'read_file' },
      }),
      JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"path": ' },
      }),
      JSON.stringify({ type: 'content_block_stop', index: 0 }),
      JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
    ]);
    const deltas = await collect(anthropicMessagesProvider(config('anthropic'))(params));

    expect(toolCallDeltas(deltas)).toHaveLength(0);
    const errors = errorDeltas(deltas);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('tool_args_parse_failed');
    expect(errors[0]!.message).toContain('tu_1');
    expect(errors[0]!.message).toContain('{"path":');
  });

  it('chatgpt + responsesApi: malformed function args → error with code + id + excerpt', async () => {
    const frames = [
      JSON.stringify({
        type: 'response.output_item.added',
        item: { type: 'function_call', call_id: 'fc_1', name: 'read_file', arguments: '' },
      }),
      JSON.stringify({
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        delta: '{"path": ',
      }),
      JSON.stringify({
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: 'fc_1', name: 'read_file', arguments: '' },
      }),
      JSON.stringify({ type: 'response.completed', response: {} }),
    ];
    for (const [provider, providerId] of [
      [chatgptResponsesProvider(config('chatgpt')), 'chatgpt'],
      [responsesApiProvider(config('openai-compatible')), 'responsesApi'],
    ] as const) {
      stubSseFetch(frames);
      const deltas = await collect(provider(params));
      expect(toolCallDeltas(deltas), providerId).toHaveLength(0);
      const errors = errorDeltas(deltas);
      expect(errors, providerId).toHaveLength(1);
      expect(errors[0]!.message, providerId).toContain('tool_args_parse_failed');
      expect(errors[0]!.message, providerId).toContain('fc_1');
      expect(errors[0]!.message, providerId).toContain('{"path":');
    }
  });
});
