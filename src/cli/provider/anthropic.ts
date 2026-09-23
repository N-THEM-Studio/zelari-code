/**
 * Anthropic Messages API stream (subscription OAuth or API key).
 */
import type { ProviderDelta, ProviderStreamFn, AgentMessage } from '@zelari/core/harness';
// M2.1/M2.2: the ephemeral trailing-context message (`<context-update>`) is what
// tells this adapter where history ends and the new turn begins, so the second
// cache breakpoint can pin the transcript instead of the churning tail.
import { isTrailingContextContent } from '@zelari/core/skills';
import {
  type OpenAICompatibleConfig,
  PROVIDER_CONNECT_TIMEOUT_MS,
  PROVIDER_STREAM_IDLE_MS,
  PROVIDER_STREAM_MAX_MS,
  readChunkWithTimeout,
} from './openai-compatible.js';
import { formatToolArgsParseError, parseToolArgsJson } from './toolArgs.js';
import { resolvePromptCacheTtl } from '../hooks/chatStats.js';
import { translateAnthropicThinking } from '../thinking.js';

const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA = 'oauth-2025-04-20';
/** Required to activate the extended (1h) prompt-cache TTL. */
const ANTHROPIC_BETA_EXTENDED_CACHE_TTL = 'extended-cache-ttl-2025-04-11';

function authHeaders(apiKey: string, longCacheTtl: boolean): Record<string, string> {
  const beta = longCacheTtl
    ? `${ANTHROPIC_BETA},${ANTHROPIC_BETA_EXTENDED_CACHE_TTL}`
    : ANTHROPIC_BETA;
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': beta,
    Authorization: `Bearer ${apiKey}`,
    'x-api-key': apiKey,
  };
}

function splitMessages(messages: AgentMessage[]): {
  systemParts: string[];
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
  return { systemParts, rest };
}

/**
 * Tag the last content block of a message with `cache_control` — the
 * rolling conversation breakpoint. Anthropic caches the longest previously
 * seen prefix ending at a breakpoint, so each turn's final message extends
 * the cached prefix instead of re-billing the whole transcript.
 */
function withRollingCacheBreakpoint(
  msg: Record<string, unknown>,
  cacheControl: Record<string, unknown>,
): Record<string, unknown> {
  const content = msg.content;
  if (typeof content === 'string') {
    return { ...msg, content: [{ type: 'text', text: content, cache_control: cacheControl }] };
  }
  if (Array.isArray(content) && content.length > 0) {
    const blocks = content.slice();
    const last = blocks[blocks.length - 1] as Record<string, unknown>;
    blocks[blocks.length - 1] = { ...last, cache_control: cacheControl };
    return { ...msg, content: blocks };
  }
  return msg;
}

/**
 * Index of the ephemeral trailing-context message (M2.1) in the wire messages,
 * or -1 when the request does not carry one (legacy layout / degraded paths).
 * `splitMessages` keeps a plain string content for user messages, so the tag
 * check is enough.
 */
function trailingContextIndex(messages: Array<Record<string, unknown>>): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i].content;
    if (typeof content === 'string' && isTrailingContextContent(content)) return i;
  }
  return -1;
}

export function anthropicMessagesProvider(config: OpenAICompatibleConfig): ProviderStreamFn {
  return async function* (params): AsyncIterable<ProviderDelta> {
    const { systemParts, rest } = splitMessages(params.messages);

    // Explicit prompt-cache breakpoints (Anthropic-only mechanism; the
    // OpenAI-compatible path relies on automatic server-side caching).
    //   1. stable system block — caches tools + stable prompt prefix. In the
    //      M2.1 layout the system is a single block (stable only), so this
    //      degenerates to `system[0]`; in the legacy layout the volatile
    //      block sits after it, so the stable boundary is the penultimate one.
    //   2. end of history + trailing context — the last STABLE block before the
    //      new turn. With the M2.1 trailing layout that boundary is the
    //      ephemeral `<context-update>` message, so the whole transcript stays
    //      cached while workspace/RAG churn busts only the tail. When no
    //      trailing message is present this is the last message, i.e. exactly
    //      the pre-M2 rolling breakpoint (legacy layout: no regression).
    //   3. rolling tail — the last message, so a multi-step tool loop keeps
    //      extending the cached prefix instead of re-billing the tool results
    //      it just appended. Skipped when it coincides with (2).
    // Budget: at most 3 of the 4 breakpoints Anthropic allows. A breakpoint is
    // only honoured above the model's minimum cacheable prefix (1k–2k tokens),
    // which tools + system already exceed here.
    const ttlPref = resolvePromptCacheTtl();
    const cacheControl: Record<string, unknown> =
      ttlPref === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };

    const trailingIdx = trailingContextIndex(rest);
    const rollingIndices = new Set<number>();
    if (rest.length > 0) {
      if (trailingIdx >= 0) rollingIndices.add(trailingIdx);
      rollingIndices.add(rest.length - 1);
    }
    const body: Record<string, unknown> = {
      model: params.model,
      max_tokens: 16_384,
      messages:
        rest.length > 0
          ? rest.map((m, i) =>
              rollingIndices.has(i) ? withRollingCacheBreakpoint(m, cacheControl) : m,
            )
          : rest,
      stream: true,
    };
    if (systemParts.length > 0) {
      const stableIdx = systemParts.length >= 2 ? systemParts.length - 2 : 0;
      body.system = systemParts.map((text, i) =>
        i === stableIdx
          ? { type: 'text', text, cache_control: cacheControl }
          : { type: 'text', text },
      );
    }
    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    // Unified thinking-effort selection (ADR-0017).
    const thinkingSpec = config.thinking ?? 'auto';
    if (thinkingSpec !== 'auto') {
      const t = translateAnthropicThinking(thinkingSpec, config.model);
      if (t.degraded) console.warn(`[thinking] ${t.note ?? 'unsupported'} — falling back to provider default.`);
      else Object.assign(body, t.patch);
    }

    const base = config.baseUrl.replace(/\/$/, '').replace(/\/v1$/, '');
    const url = `${base}/v1/messages`;
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
        headers: authHeaders(config.apiKey, ttlPref === '1h'),
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
    let currentTool: { id: string; name: string; argsJson: string } | null = null;
    let emittedTool = false;
    // Prompt-side usage arrives on `message_start` (input + cache fields);
    // completion tokens arrive later on `message_delta.usage`. Held here so
    // the single emitted usage delta reports the full picture.
    let startUsage: {
      inputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    } | null = null;

    const flushTool = function* (): Generator<ProviderDelta> {
      if (!currentTool?.name) return;
      // K4.1: malformed args JSON is a loud typed error (tool_args_parse_failed)
      // on the stream error channel — never a silent `args = {}` degradation.
      const parsed = parseToolArgsJson(currentTool.argsJson, currentTool.id);
      emittedTool = true;
      if (!parsed.ok) {
        yield { kind: 'error', message: formatToolArgsParseError(parsed.error) };
        currentTool = null;
        return;
      }
      yield {
        kind: 'tool_call',
        toolCallId: currentTool.id,
        toolName: currentTool.name,
        args: parsed.args,
      };
      currentTool = null;
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
          const type = ev.type;
          // SSE `ping` keep-alives do NOT reset the idle timer.
          if (type !== 'ping') lastUsefulAt = Date.now();
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
          } else if (type === 'message_start') {
            const usage = (ev.message as { usage?: Record<string, unknown> } | undefined)?.usage;
            if (usage) {
              const num = (v: unknown): number =>
                typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
              startUsage = {
                inputTokens: num(usage.input_tokens),
                cacheReadTokens: num(usage.cache_read_input_tokens),
                cacheCreationTokens: num(usage.cache_creation_input_tokens),
              };
            }
          } else if (type === 'message_delta') {
            const usage = (ev.usage ?? (ev.delta as { usage?: unknown } | undefined)?.usage) as
              | { input_tokens?: number; output_tokens?: number }
              | undefined;
            if (usage) {
              // Anthropic reports uncached input separately from cache
              // read/creation tokens; promptTokens must include all three to
              // match the OpenAI-compatible path (where prompt_tokens already
              // contains cached tokens) so cost accounting stays consistent.
              const uncachedInput =
                startUsage?.inputTokens ?? (usage.input_tokens ?? 0);
              const cacheRead = startUsage?.cacheReadTokens ?? 0;
              const cacheCreation = startUsage?.cacheCreationTokens ?? 0;
              const promptTokens = uncachedInput + cacheRead + cacheCreation;
              const completionTokens = usage.output_tokens ?? 0;
              yield {
                kind: 'usage',
                usage: {
                  promptTokens,
                  completionTokens,
                  totalTokens: promptTokens + completionTokens,
                  ...(cacheRead > 0 ? { cachedPromptTokens: cacheRead } : {}),
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
