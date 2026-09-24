/**
 * responsesSse.test — tool-call args contract of the shared Responses SSE loop
 * (2026-09-24 muse incident: every tentacle tool call arrived with `{}`).
 *
 * Pinned: correlation by item id AND call_id (spec: deltas reference
 * `item_id` = `item.id`, not `call_id`), the full-args `done` channels, object
 * args, done-without-added, the `tool_args_missing` advisory, the OpenAI
 * delta-streaming regression (no duplication), and frame-debug redaction.
 * Every scenario runs through BOTH adapters (chatgpt + responsesApi/muse).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderDelta } from '@zelari/core/harness';
import type { OpenAICompatibleConfig } from './openai-compatible.js';
import { chatgptResponsesProvider } from './chatgpt.js';
import { responsesApiProvider } from './responsesApi.js';
import { readResponsesSse, TOOL_ARGS_MISSING_CODE } from './responsesSse.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.ZELARI_PROVIDER_FRAME_DEBUG;
  vi.restoreAllMocks();
});

function config(providerId: OpenAICompatibleConfig['providerId']): OpenAICompatibleConfig {
  return { apiKey: 'k', baseUrl: 'https://provider.test/v1', model: 'm', providerId };
}

const READ_FILE = {
  name: 'read_file',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};
const TODO_READ = {
  name: 'todo_read',
  description: 'Read todos',
  parameters: { type: 'object', properties: {} },
};

function params(tools: unknown[] = [READ_FILE, TODO_READ]) {
  return { messages: [], model: 'm', provider: 'test', tools } as never;
}

function sseBody(frames: unknown[], opts: { trailingNewline?: boolean } = {}): string {
  const text = frames.map((f) => `data: ${JSON.stringify(f)}`).join('\n\n');
  return opts.trailingNewline === false ? text : `${text}\n\n`;
}

function stubFetch(frames: unknown[]): void {
  (globalThis as { fetch: unknown }).fetch = async () =>
    new Response(sseBody(frames), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collect(gen: AsyncIterable<ProviderDelta>): Promise<ProviderDelta[]> {
  const out: ProviderDelta[] = [];
  for await (const d of gen) out.push(d);
  return out;
}

const ADAPTERS = [
  ['chatgpt', () => chatgptResponsesProvider(config('chatgpt'))],
  ['muse', () => responsesApiProvider(config('muse'))],
] as const;

async function runBoth(frames: unknown[], tools?: unknown[]) {
  const results: Array<[string, ProviderDelta[]]> = [];
  for (const [label, make] of ADAPTERS) {
    stubFetch(frames);
    results.push([label, await collect(make()(params(tools)))]);
  }
  return results;
}

const toolCalls = (ds: ProviderDelta[]) => ds.filter((d) => d.kind === 'tool_call');
const errors = (ds: ProviderDelta[]) =>
  ds.filter((d): d is Extract<ProviderDelta, { kind: 'error' }> => d.kind === 'error');

const added = (extra: Record<string, unknown> = {}) => ({
  type: 'response.output_item.added',
  output_index: 1,
  item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '', ...extra },
});
const itemDone = (args: unknown) => ({
  type: 'response.output_item.done',
  output_index: 1,
  item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: args },
});
const completed = { type: 'response.completed', response: {} };
const EXPECTED = { kind: 'tool_call', toolCallId: 'call_1', toolName: 'read_file', args: { path: 'package.json' } };

describe('Responses SSE — tool-call args (muse incident)', () => {
  it('spec-conformant stream: deltas keyed by item_id (fc_…) reach the call keyed by call_id', async () => {
    for (const [label, ds] of await runBoth([
      added(),
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '{"path":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '"package.json"}' },
      // done WITHOUT arguments: the accumulated deltas must survive.
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1' } },
      completed,
    ])) {
      expect(toolCalls(ds), label).toEqual([EXPECTED]);
      expect(errors(ds), label).toEqual([]);
      expect(ds.at(-1), label).toEqual({ kind: 'finish', reason: 'tool_calls' });
    }
  });

  it('H1a: no deltas, full args only on output_item.done', async () => {
    for (const [label, ds] of await runBoth([added(), itemDone('{"path":"package.json"}'), completed])) {
      expect(toolCalls(ds), label).toEqual([EXPECTED]);
      expect(errors(ds), label).toEqual([]);
    }
  });

  it('H1b: full args only on response.function_call_arguments.done', async () => {
    for (const [label, ds] of await runBoth([
      added(),
      { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 1, arguments: '{"path":"package.json"}' },
      itemDone(''),
      completed,
    ])) {
      expect(toolCalls(ds), label).toEqual([EXPECTED]);
    }
  });

  it('H1c: arguments delivered as an already-parsed object', async () => {
    for (const [label, ds] of await runBoth([added(), itemDone({ path: 'package.json' }), completed])) {
      expect(toolCalls(ds), label).toEqual([EXPECTED]);
    }
  });

  it('output_item.done without any added frame still yields the call', async () => {
    for (const [label, ds] of await runBoth([itemDone('{"path":"package.json"}'), completed])) {
      expect(toolCalls(ds), label).toEqual([EXPECTED]);
    }
  });

  it('adopts call_id from done when added only carried the item id', async () => {
    for (const [label, ds] of await runBoth([
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', name: 'read_file' } },
      itemDone('{"path":"package.json"}'),
      completed,
    ])) {
      expect(toolCalls(ds), label).toEqual([EXPECTED]);
    }
  });

  it('OpenAI regression: delta streaming + done with the same full string is byte-identical, no duplication', async () => {
    const full = '{"path":"src/a.ts","offset":10}';
    for (const [label, ds] of await runBoth([
      added(),
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: full.slice(0, 12) },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: full.slice(12) },
      { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 1, arguments: full },
      itemDone(full),
      completed,
    ])) {
      expect(toolCalls(ds), label).toEqual([
        { kind: 'tool_call', toolCallId: 'call_1', toolName: 'read_file', args: JSON.parse(full) },
      ]);
    }
  });

  it('legacy fixture shape (item_id === call_id) keeps working', async () => {
    for (const [label, ds] of await runBoth([
      { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'call_1', delta: '{"path":"package.json"}' },
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1' } },
      completed,
    ])) {
      expect(toolCalls(ds), label).toEqual([EXPECTED]);
    }
  });

  it('parallel calls: interleaved deltas are routed by item id, never cross-attributed', async () => {
    const add = (n: number, name: string) => ({
      type: 'response.output_item.added',
      output_index: n,
      item: { type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name, arguments: '' },
    });
    const delta = (n: number, d: string) => ({
      type: 'response.function_call_arguments.delta', item_id: `fc_${n}`, output_index: n, delta: d,
    });
    const done = (n: number) => ({
      type: 'response.output_item.done', output_index: n, item: { type: 'function_call', id: `fc_${n}`, call_id: `call_${n}` },
    });
    for (const [label, ds] of await runBoth([
      add(1, 'read_file'), add(2, 'read_file'),
      delta(1, '{"path":'), delta(2, '{"path":'), delta(2, '"b.ts"}'), delta(1, '"a.ts"}'),
      done(1), done(2), completed,
    ])) {
      expect(toolCalls(ds), label).toEqual([
        { kind: 'tool_call', toolCallId: 'call_1', toolName: 'read_file', args: { path: 'a.ts' } },
        { kind: 'tool_call', toolCallId: 'call_2', toolName: 'read_file', args: { path: 'b.ts' } },
      ]);
    }
  });

  it('a late delta for an already-flushed call never leaks into the next open call', async () => {
    for (const [label, ds] of await runBoth([
      added(),
      itemDone('{"path":"package.json"}'),
      { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'read_file', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: 'GARBAGE' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_2', output_index: 2, delta: '{"path":"b.ts"}' },
      { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', id: 'fc_2', call_id: 'call_2' } },
      completed,
    ])) {
      expect(errors(ds), label).toEqual([]);
      expect(toolCalls(ds), label).toEqual([
        EXPECTED,
        { kind: 'tool_call', toolCallId: 'call_2', toolName: 'read_file', args: { path: 'b.ts' } },
      ]);
    }
  });

  it('tool_args_missing: empty args for a tool with required params is loud but still forwarded', async () => {
    for (const [label, ds] of await runBoth([added(), itemDone(''), completed])) {
      const errs = errors(ds);
      expect(errs, label).toHaveLength(1);
      expect(errs[0]!.message, label).toContain(TOOL_ARGS_MISSING_CODE);
      expect(errs[0]!.message, label).toContain('call_1');
      expect(errs[0]!.message, label).toContain('path');
      expect(toolCalls(ds), label).toEqual([
        { kind: 'tool_call', toolCallId: 'call_1', toolName: 'read_file', args: {} },
      ]);
    }
  });

  it('zero-arg tools stay silent (legit `arguments: ""`)', async () => {
    for (const [label, ds] of await runBoth([
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_9', call_id: 'call_9', name: 'todo_read', arguments: '' } },
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_9', call_id: 'call_9', name: 'todo_read', arguments: '' } },
      completed,
    ])) {
      expect(errors(ds), label).toEqual([]);
      expect(toolCalls(ds), label).toEqual([
        { kind: 'tool_call', toolCallId: 'call_9', toolName: 'todo_read', args: {} },
      ]);
    }
  });

  it('a call still pending at response.completed is flushed, not lost', async () => {
    for (const [label, ds] of await runBoth([
      added(),
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":"package.json"}' },
      { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 2 } } },
    ])) {
      expect(toolCalls(ds), label).toEqual([EXPECTED]);
      expect(ds.at(-1), label).toEqual({ kind: 'finish', reason: 'tool_calls' });
    }
  });

  it('response.failed surfaces the nested error message', async () => {
    for (const [label, ds] of await runBoth([
      { type: 'response.failed', response: { error: { code: 'server_error', message: 'upstream exploded' } } },
    ])) {
      expect(errors(ds).map((e) => e.message), label).toEqual(['upstream exploded']);
    }
  });
});

describe('readResponsesSse — stream framing + diagnostics', () => {
  it('processes a final frame that lacks a trailing newline', async () => {
    const body = new Response(sseBody([{ type: 'response.output_text.delta', delta: 'hi' }, completed], { trailingNewline: false })).body!;
    const ds = await collect(readResponsesSse(body, { label: 't' }));
    expect(ds).toEqual([{ kind: 'text', delta: 'hi' }, { kind: 'finish', reason: 'stop' }]);
  });

  it('ZELARI_PROVIDER_FRAME_DEBUG=1 logs event shapes, never argument content', async () => {
    process.env.ZELARI_PROVIDER_FRAME_DEBUG = '1';
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    const body = new Response(sseBody([added(), itemDone('{"path":"SECRET.txt"}'), completed])).body!;
    await collect(readResponsesSse(body, { label: 'responses:muse' }));
    const out = lines.join('');
    expect(out).toContain('[frame:responses:muse] response.output_item.done');
    expect(out).toContain('item.id=fc_1');
    expect(out).toContain('item.call_id=call_1');
    expect(out).toContain('item.arguments=string(21)');
    expect(out).not.toContain('SECRET');
  });

  it('frame debug is off by default', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const body = new Response(sseBody([completed])).body!;
    await collect(readResponsesSse(body, { label: 't' }));
    expect(spy).not.toHaveBeenCalled();
  });
});
