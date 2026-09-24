/**
 * ChatGPT Codex Responses API stream (subscription OAuth).
 */
import type { ProviderDelta, ProviderStreamFn, AgentMessage } from '@zelari/core/harness';
import { type OpenAICompatibleConfig, PROVIDER_CONNECT_TIMEOUT_MS } from './openai-compatible.js';
import { readResponsesSse } from './responsesSse.js';
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

export function toInput(messages: AgentMessage[]): {
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

    // SSE event loop shared with responsesApi.ts (same wire format).
    yield* readResponsesSse(response.body, {
      signal: params.signal,
      tools: params.tools,
      label: 'chatgpt',
    });
  };
}
