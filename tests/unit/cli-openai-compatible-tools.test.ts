import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { openaiCompatibleProvider } from '../../src/cli/provider/openai-compatible.js';

interface FetchMock {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

const originalFetch = globalThis.fetch;

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
  (globalThis as { fetch: FetchMock }).fetch = async () => response;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('openaiCompatibleProvider — SSE tool_calls parsing (Task A1)', () => {
  it('emits text deltas as before', async () => {
    mockFetchWithSseChunks([
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const provider = openaiCompatibleProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-test',
      providerId: 'openai-compatible',
    });
    const deltas: string[] = [];
    for await (const d of provider({ messages: [], model: 'gpt-test', provider: 'openai-compatible', tools: [] })) {
      if (d.kind === 'text') deltas.push(d.delta);
    }
    expect(deltas.join('')).toBe('hello world');
  });

  it('emits a tool_call delta when args JSON closes', async () => {
    mockFetchWithSseChunks([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"/tmp/x\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const provider = openaiCompatibleProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-test',
      providerId: 'openai-compatible',
    });
    let toolCall: { name: string; args: Record<string, unknown>; id: string } | null = null;
    for await (const d of provider({ messages: [], model: 'gpt-test', provider: 'openai-compatible', tools: [] })) {
      if (d.kind === 'tool_call') {
        toolCall = { name: d.toolName, args: d.args, id: d.toolCallId };
      }
    }
    expect(toolCall).not.toBeNull();
    expect(toolCall!.name).toBe('read_file');
    expect(toolCall!.args).toEqual({ path: '/tmp/x' });
    expect(toolCall!.id).toBe('tc_1');
  });

  it('accumulates args across multiple chunks before emitting', async () => {
    mockFetchWithSseChunks([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc_2","function":{"name":"write_file","arguments":"{\\"path\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"/tmp/y\\","}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"content\\":\\"hi\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const provider = openaiCompatibleProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-test',
      providerId: 'openai-compatible',
    });
    let toolCall: { name: string; args: Record<string, unknown> } | null = null;
    for await (const d of provider({ messages: [], model: 'gpt-test', provider: 'openai-compatible', tools: [] })) {
      if (d.kind === 'tool_call') {
        toolCall = { name: d.toolName, args: d.args };
      }
    }
    expect(toolCall).not.toBeNull();
    expect(toolCall!.name).toBe('write_file');
    expect(toolCall!.args).toEqual({ path: '/tmp/y', content: 'hi' });
  });

  it('emits text and tool_call in the same stream', async () => {
    mockFetchWithSseChunks([
      'data: {"choices":[{"delta":{"content":"I will read the file. "}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc_3","function":{"name":"read_file","arguments":"{\\"path\\":\\"foo.txt\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const provider = openaiCompatibleProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-test',
      providerId: 'openai-compatible',
    });
    const texts: string[] = [];
    let toolCallName: string | null = null;
    for await (const d of provider({ messages: [], model: 'gpt-test', provider: 'openai-compatible', tools: [] })) {
      if (d.kind === 'text') texts.push(d.delta);
      if (d.kind === 'tool_call') toolCallName = d.toolName;
    }
    expect(texts.join('')).toBe('I will read the file. ');
    expect(toolCallName).toBe('read_file');
  });

  it('emits finish after tool_call deltas', async () => {
    mockFetchWithSseChunks([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc_4","function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const provider = openaiCompatibleProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-test',
      providerId: 'openai-compatible',
    });
    let sawToolCall = false;
    let sawFinish = false;
    for await (const d of provider({ messages: [], model: 'gpt-test', provider: 'openai-compatible', tools: [] })) {
      if (d.kind === 'tool_call') sawToolCall = true;
      if (d.kind === 'finish') sawFinish = true;
    }
    expect(sawToolCall).toBe(true);
    expect(sawFinish).toBe(true);
  });

  it('skips malformed JSON lines without crashing', async () => {
    mockFetchWithSseChunks([
      'data: not json\n\n',
      'data: {"choices":[{"delta":{"content":"survivor"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const provider = openaiCompatibleProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-test',
      providerId: 'openai-compatible',
    });
    const texts: string[] = [];
    for await (const d of provider({ messages: [], model: 'gpt-test', provider: 'openai-compatible', tools: [] })) {
      if (d.kind === 'text') texts.push(d.delta);
    }
    expect(texts.join('')).toBe('survivor');
  });
});