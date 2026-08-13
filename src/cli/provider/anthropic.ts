/**
 * Anthropic Messages API stream (subscription OAuth or API key).
 */
import type { ProviderDelta, ProviderStreamFn, AgentMessage } from '@zelari/core/harness';
import type { OpenAICompatibleConfig } from './openai-compatible.js';

const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA = 'oauth-2025-04-20';

function authHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': ANTHROPIC_BETA,
    Authorization: `Bearer ${apiKey}`,
    'x-api-key': apiKey,
  };
}

function splitMessages(messages: AgentMessage[]): {
  system: string;
  rest: Array<Record<string, unknown>>;
} {
  const systemParts: string[] = [];
  const rest: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) systemParts.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      rest.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId,
            content: m.content ?? '',
          },
        ],
      });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const content: Array<Record<string, unknown>> = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.args ?? {},
        });
      }
      rest.push({ role: 'assistant', content });
      continue;
    }
    rest.push({ role: m.role, content: m.content ?? '' });
  }
  return { system: systemParts.join('\n\n'), rest };
}

export function anthropicMessagesProvider(config: OpenAICompatibleConfig): ProviderStreamFn {
  return async function* (params): AsyncIterable<ProviderDelta> {
    const { system, rest } = splitMessages(params.messages);
    const body: Record<string, unknown> = {
      model: params.model,
      max_tokens: 16_384,
      messages: rest,
      stream: true,
    };
    if (system) body.system = system;
    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    const base = config.baseUrl.replace(/\/$/, '').replace(/\/v1$/, '');
    const url = `${base}/v1/messages`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: authHeaders(config.apiKey),
        body: JSON.stringify(body),
        signal: params.signal,
      });
    } catch (err) {
      yield {
        kind: 'error',
        message: `Network error: ${err instanceof Error ? err.message : String(err)}`,
      };
      return;
    }
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      yield { kind: 'error', message: `HTTP ${response.status}: ${text.slice(0, 240)}` };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentTool: { id: string; name: string; argsJson: string } | null = null;
    let emittedTool = false;

    const flushTool = function* (): Generator<ProviderDelta> {
      if (!currentTool?.name) return;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(currentTool.argsJson || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }
      emittedTool = true;
      yield {
        kind: 'tool_call',
        toolCallId: currentTool.id,
        toolName: currentTool.name,
        args,
      };
      currentTool = null;
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }
          const type = ev.type;
          if (type === 'content_block_delta') {
            const delta = ev.delta as Record<string, unknown> | undefined;
            if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
              yield { kind: 'text', delta: delta.text };
            } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
              yield { kind: 'thinking', delta: delta.thinking };
            } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
              if (currentTool) currentTool.argsJson += delta.partial_json;
            }
          } else if (type === 'content_block_start') {
            const block = ev.content_block as Record<string, unknown> | undefined;
            if (block?.type === 'tool_use') {
              currentTool = {
                id: typeof block.id === 'string' ? block.id : `tu-${Date.now()}`,
                name: typeof block.name === 'string' ? block.name : '',
                argsJson: '',
              };
            }
          } else if (type === 'content_block_stop') {
            yield* flushTool();
          } else if (type === 'message_delta') {
            const usage = (ev.usage ?? (ev.delta as { usage?: unknown } | undefined)?.usage) as
              | { input_tokens?: number; output_tokens?: number }
              | undefined;
            if (usage) {
              yield {
                kind: 'usage',
                usage: {
                  promptTokens: usage.input_tokens ?? 0,
                  completionTokens: usage.output_tokens ?? 0,
                  totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
                },
              };
            }
            const stop = (ev.delta as { stop_reason?: string } | undefined)?.stop_reason;
            if (stop) {
              yield {
                kind: 'finish',
                reason: stop === 'tool_use' || emittedTool ? 'tool_calls' : 'stop',
              };
            }
          } else if (type === 'error') {
            const msg =
              typeof (ev.error as { message?: string } | undefined)?.message === 'string'
                ? (ev.error as { message: string }).message
                : 'Anthropic stream error';
            yield { kind: 'error', message: msg };
            return;
          }
        }
      }
      yield* flushTool();
      yield { kind: 'finish', reason: emittedTool ? 'tool_calls' : 'stop' };
    } finally {
      reader.releaseLock();
    }
  };
}
