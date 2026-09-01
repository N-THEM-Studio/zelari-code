/**
 * ChatGPT Codex Responses API stream (subscription OAuth).
 */
import type { ProviderDelta, ProviderStreamFn, AgentMessage } from '@zelari/core/harness';
import {
  type OpenAICompatibleConfig,
  PROVIDER_CONNECT_TIMEOUT_MS,
  PROVIDER_STREAM_IDLE_MS,
  PROVIDER_STREAM_MAX_MS,
  readChunkWithTimeout,
} from './openai-compatible.js';
import { translateResponsesThinking } from '../thinking.js';

function headers(config: OpenAICompatibleConfig): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Authorization: `Bearer ${config.apiKey}`,
    'OpenAI-Beta': 'responses=experimental',
  };
  if (config.accountId) h['ChatGPT-Account-Id'] = config.accountId;
  if (config.extraHeaders) Object.assign(h, config.extraHeaders);
  return h;
}

function toInput(messages: AgentMessage[]): {
  instructions: string;
  input: Array<Record<string, unknown>>;
} {
  const instructions: string[] = [];
  const input: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) instructions.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.toolCallId,
        output: m.content ?? '',
      });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      if (m.content) input.push({ role: 'assistant', content: m.content });
      for (const tc of m.toolCalls) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.args ?? {}),
        });
      }
      continue;
    }
    input.push({ role: m.role, content: m.content ?? '' });
  }
  return { instructions: instructions.join('\n\n'), input };
}

export function chatgptResponsesProvider(config: OpenAICompatibleConfig): ProviderStreamFn {
  return async function* (params): AsyncIterable<ProviderDelta> {
    const { instructions, input } = toInput(params.messages);
    const body: Record<string, unknown> = {
      model: params.model,
      stream: true,
      input,
    };
    if (instructions) body.instructions = instructions;
    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
    }

    // Unified thinking-effort selection (ADR-0017).
    const thinkingSpec = config.thinking ?? 'auto';
    if (thinkingSpec !== 'auto') {
      const t = translateResponsesThinking(thinkingSpec, config.model);
      if (t.degraded) console.warn(`[thinking] ${t.note ?? 'unsupported'} — falling back to provider default.`);
      else Object.assign(body, t.patch);
    }

    const base = config.baseUrl.replace(/\/$/, '');
    const url = `${base}/responses`;
    let response: Response;
    // CONNECT-only timeout (policy identical to openai-compatible.ts): if
    // response headers never arrive, fail visibly — never the infinite hang
    // of the field report "the model never answers". The stream itself is
    // governed by the idle/max timers below, not by a wall-clock on the
    // whole fetch.
    const connectController = new AbortController();
    const connectTimer = setTimeout(
      () =>
        connectController.abort(
          new Error(
            `Provider connect timeout after ${Math.round(PROVIDER_CONNECT_TIMEOUT_MS / 1000)}s ` +
              `(no response headers). Override ZELARI_PROVIDER_CONNECT_TIMEOUT_MS.`,
          ),
        ),
      PROVIDER_CONNECT_TIMEOUT_MS,
    );
    const signals: AbortSignal[] = [connectController.signal];
    if (params.signal) signals.push(params.signal);
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: headers(config),
        body: JSON.stringify(body),
        signal: signals.length === 1 ? signals[0]! : AbortSignal.any(signals),
      });
      clearTimeout(connectTimer);
    } catch (err) {
      clearTimeout(connectTimer);
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
    const tools = new Map<string, { id: string; name: string; argsJson: string }>();
    let emittedTool = false;

    const flush = function* (id: string): Generator<ProviderDelta> {
      const t = tools.get(id);
      if (!t?.name) return;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(t.argsJson || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }
      tools.delete(id);
      emittedTool = true;
      yield { kind: 'tool_call', toolCallId: t.id, toolName: t.name, args };
    };

    // Stream watchdog (same policy as openai-compatible.ts): idle measures
    // silence since the last USEFUL event (SSE pings don't count), max is
    // the absolute cap on the stream.
    const streamStartedAt = Date.now();
    let lastUsefulAt = streamStartedAt;
    const streamDeadline = streamStartedAt + PROVIDER_STREAM_MAX_MS;

    try {
      while (true) {
        const { value, done } = await readChunkWithTimeout(reader, {
          idleMs: PROVIDER_STREAM_IDLE_MS,
          deadlineMs: streamDeadline,
          signal: params.signal,
          lastUsefulAt: () => lastUsefulAt,
        });
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
          const type = typeof ev.type === 'string' ? ev.type : '';
          if (type) lastUsefulAt = Date.now();
          if (type === 'response.output_text.delta' && typeof ev.delta === 'string') {
            yield { kind: 'text', delta: ev.delta };
          } else if (type === 'response.reasoning_text.delta' && typeof ev.delta === 'string') {
            yield { kind: 'thinking', delta: ev.delta };
          } else if (type === 'response.output_item.added') {
            const item = ev.item as Record<string, unknown> | undefined;
            if (item?.type === 'function_call') {
              const id = String(item.call_id ?? item.id ?? `fc-${tools.size}`);
              tools.set(id, {
                id,
                name: typeof item.name === 'string' ? item.name : '',
                argsJson: typeof item.arguments === 'string' ? item.arguments : '',
              });
            }
          } else if (type === 'response.function_call_arguments.delta') {
            const itemId = String(ev.item_id ?? ev.call_id ?? '');
            const existing = itemId ? tools.get(itemId) : [...tools.values()].at(-1);
            if (existing && typeof ev.delta === 'string') existing.argsJson += ev.delta;
          } else if (type === 'response.output_item.done') {
            const item = ev.item as Record<string, unknown> | undefined;
            if (item?.type === 'function_call') {
              const id = String(item.call_id ?? item.id ?? '');
              if (id) yield* flush(id);
            }
          } else if (type === 'response.completed') {
            const usage = (ev.response as { usage?: Record<string, number> } | undefined)?.usage;
            if (usage) {
              yield {
                kind: 'usage',
                usage: {
                  promptTokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
                  completionTokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
                  totalTokens:
                    usage.total_tokens ??
                    (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
                },
              };
            }
            yield { kind: 'finish', reason: emittedTool ? 'tool_calls' : 'stop' };
            return;
          } else if (type === 'response.failed' || type === 'error') {
            const msg =
              typeof ev.message === 'string'
                ? ev.message
                : JSON.stringify(ev.error ?? ev).slice(0, 200);
            yield { kind: 'error', message: msg };
            return;
          }
        }
      }
      for (const id of [...tools.keys()]) yield* flush(id);
      yield { kind: 'finish', reason: emittedTool ? 'tool_calls' : 'stop' };
    } finally {
      reader.releaseLock();
    }
  };
}
