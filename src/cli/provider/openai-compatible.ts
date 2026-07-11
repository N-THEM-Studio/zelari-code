/**
 * OpenAI-compatible HTTP provider.
 * Works against any chat-completions endpoint that follows OpenAI's
 * streaming protocol: minimax, glm, grok, custom.
 *
 * Reads API key from the active provider (env first, then keyStore).
 * Resolves baseUrl via `PROVIDER_ENDPOINTS` (providerId → baseUrl).
 * Resolves model via `providerConfig.getModelForProvider(id)`.
 *
 * Active provider resolution: `ANATHEMA_ACTIVE_PROVIDER` env first, then
 * the on-disk providerConfig.json (Phase 15), default `openai-compatible`.
 *
 * Implements ProviderStreamFn (AsyncIterable<ProviderDelta>).
 */

import type { ProviderStreamFn, ProviderDelta } from '@zelari/core/harness';
import type { ProviderName } from '../keyStore.js';
import { resolveApiKeyWithMeta } from '../keyStore.js';
import { getProviderConfig, getModelForProvider, getCustomEndpoint } from '../providerConfig.js';

/**
 * v1.5.2: transient-HTTP retry. A single 429/5xx/network failure used to flip
 * the whole council member turn to `reason:'error'` (AgentHarness treats any
 * `recoverable` error event as terminal). For LLM providers this is almost
 * always transient — rate-limit windows clear in seconds, 502s are gateway
 * blips. We retry on the initial response (before any stream byte is read),
 * so there is no mid-stream state to recover from.
 *
 * Tunables:
 *   - RETRYABLE_STATUSES: the status codes we consider transient.
 *   - MAX_RETRIES: attempts after the first. 3 → 4 fetches total worst case.
 *   - Backoff: exponential, base 500ms × 2^attempt, capped at 8s. Honors
 *     `Retry-After` (seconds) when the provider sets it (rare for LLM APIs
 *     but standard HTTP). Overridable via ZELARI_PROVIDER_MAX_RETRIES.
 */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES: number = (() => {
  const raw = process.env.ZELARI_PROVIDER_MAX_RETRIES;
  const n = raw ? Number.parseInt(raw, 10) : 3;
  return Number.isFinite(n) && n >= 0 ? n : 3;
})();
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8000;
/**
 * Hard timeout for a single provider HTTP request (connect + stream).
 * Without this, a provider that accepts the TCP connection but never sends a
 * response (load balancer stall, silent gateway timeout) makes fetch() hang
 * forever — the harness sits blocked in the provider stream, emits no
 * agent_end, and the desktop UI freezes ("muore e basta"). This is the
 * silent-hang root cause for long tool-loop turns on flaky providers (MiniMax).
 * Default 5 min (LLM tool turns can be slow); override via env.
 */
const PROVIDER_TIMEOUT_MS: number = (() => {
  const raw = process.env.ZELARI_PROVIDER_TIMEOUT_MS;
  const n = raw ? Number.parseInt(raw, 10) : 300_000;
  return Number.isFinite(n) && n >= 10_000 ? n : 300_000;
})();

/**
 * Sleep that aborts early if the caller's signal fires (so `.cancel()` during
 * a backoff window doesn't make the user wait for a doomed retry). Resolves
 * early on abort; the caller re-checks `signal.aborted` after we return.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/** Compute the backoff delay for a given attempt (0-indexed), honoring Retry-After. */
function backoffDelay(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number.parseFloat(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, BACKOFF_CAP_MS);
  }
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
}

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseUrl: string;       // e.g. 'https://api.x.ai/v1'
  model: string;         // e.g. 'grok-4'
  signal?: AbortSignal;
  providerId: ProviderName;
}

/**
 * Default endpoints for each provider. `openai-compatible` defaults to
 * api.x.ai (backward compatibility); `custom` is empty and must be set
 * via OPENAI_BASE_URL.
 */
export const PROVIDER_ENDPOINTS: Record<ProviderName, string> = {
  'openai-compatible': 'https://api.x.ai/v1',
  'minimax': 'https://api.minimax.io/v1',
  // GLM defaults to the Coding Plan endpoint (flat-rate coding subscription).
  // Pay-per-token API users can override with `/provider custom https://api.z.ai/api/paas/v4`.
  'glm': 'https://api.z.ai/api/coding/paas/v4',
  'grok': 'https://api.x.ai/v1',
  // DeepSeek global platform (OpenAI-compatible). Chat → /chat/completions,
  // discovery → /models against this same host.
  'deepseek': 'https://api.deepseek.com',
  'custom': '',
};

/** Resolve the active provider id (env override > on-disk config > default). */
export function resolveActiveProvider(): ProviderName {
  return getProviderConfig().activeProviderId;
}

/**
 * Extract the number of prompt tokens served from the provider's prompt
 * cache, normalizing across the two OpenAI-compatible reporting shapes:
 *   - OpenAI / xAI / GLM: `usage.prompt_tokens_details.cached_tokens`
 *   - DeepSeek:           `usage.prompt_cache_hit_tokens`
 *
 * Prompt caching is automatic server-side for these providers — there is no
 * request-side `cache_control` to send (that is an Anthropic-only mechanism).
 * The stable prompt prefix (system prompt + tool schema + early transcript)
 * gets cached and billed at a discount; this function surfaces the hit count
 * so cost accounting and the cache-hit-rate stat are accurate.
 *
 * Returns 0 when no cache field is present or the value is not a finite
 * non-negative number.
 *
 * @internal exported for unit testing
 */
export function parseCachedPromptTokens(usage: {
  prompt_tokens_details?: { cached_tokens?: number };
  prompt_cache_hit_tokens?: number;
} | null | undefined): number {
  if (!usage || typeof usage !== 'object') return 0;
  const candidates = [
    usage.prompt_tokens_details?.cached_tokens,
    usage.prompt_cache_hit_tokens,
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c >= 0) return c;
  }
  return 0;
}

/**
 * Resolve baseUrl for a given provider. Priority:
 *   1. Custom endpoint persisted via `/provider custom <url>` (wins always)
 *   2. OPENAI_BASE_URL env override (for openai-compatible / custom)
 *   3. PROVIDER_ENDPOINTS default for that provider
 */
export function resolveBaseUrl(providerId: ProviderName): string {
  const custom = getCustomEndpoint(providerId);
  if (custom) return custom;
  if (providerId === 'openai-compatible' || providerId === 'custom') {
    return process.env.OPENAI_BASE_URL ?? PROVIDER_ENDPOINTS[providerId];
  }
  return PROVIDER_ENDPOINTS[providerId];
}

export function openaiCompatibleProvider(config: OpenAICompatibleConfig): ProviderStreamFn {
  return async function* (params): AsyncIterable<ProviderDelta> {
    // Map the provider-neutral AgentMessage[] into the OpenAI chat format.
    // The harness keeps tool results as { role: 'tool', toolCallId, content }
    // and assistant tool-call turns as { role: 'assistant', content,
    // toolCalls: [{id,name,args}] } (see AgentHarness accumulation). Here we
    // translate both into the shape OpenAI expects:
    //   - assistant with tool_calls: { role:'assistant', content, tool_calls:[{id,type:'function',function:{name,arguments}}] }
    //   - tool result: { role:'tool', tool_call_id, content }
    const messages = params.messages.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'tool' as const,
          tool_call_id: m.toolCallId,
          content: m.content,
        };
      }
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        // DeepSeek thinking mode: when an assistant turn issued tool_calls,
        // `reasoning_content` MUST be echoed on every subsequent request or
        // the API returns HTTP 400. Other providers ignore the extra field.
        const msg: Record<string, unknown> = {
          role: 'assistant' as const,
          content: m.content ?? '',
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.args ?? {}),
            },
          })),
        };
        if (m.reasoningContent && m.reasoningContent.length > 0) {
          msg.reasoning_content = m.reasoningContent;
        }
        return msg;
      }
      // Assistant text-only turns may still carry reasoning_content for
      // multi-turn continuity on some providers; include when present.
      if (
        m.role === 'assistant' &&
        m.reasoningContent &&
        m.reasoningContent.length > 0
      ) {
        return {
          role: 'assistant' as const,
          content: m.content ?? '',
          reasoning_content: m.reasoningContent,
        };
      }
      return { role: m.role, content: m.content };
    });

    const body: Record<string, unknown> = {
      // Use `params.model` (per-call override from AgentHarness, e.g. for
      // `agentModels` config) rather than the closed-over `config.model`
      // default. v0.6.0 audit HIGH-3.
      model: params.model,
      messages,
      stream: true,
      temperature: 0.7,
      // Task G.4.2 — request the provider to send real token usage in
      // the final chunk (gated by `stream_options.include_usage` on the
      // OpenAI-compatible API). Providers that don't honor this (some
      // self-hosted gateways) will simply not send a `usage` chunk, and
      // the harness will fall back to the ~4-char/token approximation.
      stream_options: { include_usage: true },
    };

    // Only advertise tools when at least one is available. Many providers
    // reject an empty `tools: []` with HTTP 400, so we omit the key entirely.
    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      body.tool_choice = 'auto';
    }

    // v1.5.2: retry transient failures (429/5xx + network errors) on the
    // initial response. Retries happen BEFORE any stream byte is read, so
    // there's no mid-stream state to recover — the cleanest possible retry
    // window. Once response.body.getReader() starts below, no retry is possible.
    let response: Response | undefined;
    let lastErrText = '';
    let lastStatus = 0;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      if (params.signal?.aborted) {
        yield { kind: 'error', message: 'aborted' };
        return;
      }
      try {
        // Combine the caller's cancel signal with a hard timeout. Without the
        // timeout, a provider that stalls after accepting the connection makes
        // fetch() hang forever (the silent "muore e basta" freeze). The timeout
        // aborts the request so it surfaces as a retryable network error
        // instead of an infinite hang.
        const timeoutSignal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
        const fetchSignal = params.signal
          ? AbortSignal.any([params.signal, timeoutSignal])
          : timeoutSignal;
        response = await fetch(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(body),
          // Use `params.signal` (per-call AbortSignal from AgentHarness
          // controller) so `.cancel()` actually aborts the HTTP request.
          // `config.signal` is the factory-level signal, typically undefined.
          // v0.6.0 audit HIGH-2.
          // v1.10.0: also apply PROVIDER_TIMEOUT_MS so a stalled connection
          // can't hang the harness forever.
          signal: fetchSignal,
        });
      } catch (err) {
        // Network error (DNS, connection refused, TLS, read timeout, or our
        // PROVIDER_TIMEOUT_MS firing) — transient in most cases. Retry unless
        // this is the last attempt. A timeout-induced abort looks like a
        // normal AbortError here, so it follows the same retry path.
        lastStatus = 0;
        lastErrText = err instanceof Error ? err.message : String(err);
        // If the user cancelled, don't retry — bail out immediately.
        if (params.signal?.aborted) {
          yield { kind: 'error', message: 'aborted' };
          return;
        }
        if (attempt < MAX_RETRIES) {
          await abortableSleep(backoffDelay(attempt, null), params.signal);
          continue;
        }
        yield { kind: 'error', message: `Network error: ${lastErrText}` };
        return;
      }
      // Success or non-retryable → break out of the retry loop.
      if (response.ok && response.body) break;
      lastStatus = response.status;
      lastErrText = await response.text().catch(() => '');
      if (!RETRYABLE_STATUSES.has(response.status) || attempt >= MAX_RETRIES) break;
      // Retryable: back off honoring Retry-After if the provider set it.
      const retryAfter = response.headers.get('retry-after');
      await abortableSleep(backoffDelay(attempt, retryAfter), params.signal);
    }

    if (!response || !response.ok || !response.body) {
      const msg = lastStatus === 0
        ? `Network error: ${lastErrText}`
        : `HTTP ${lastStatus}: ${lastErrText.slice(0, 200)}`;
      yield { kind: 'error', message: msg };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // Accumulator for OpenAI tool_calls streaming (Task A1).
    // Args JSON is delivered incrementally; we emit a `tool_call` delta
    // when the accumulated args for a given index parse to a complete
    // JSON object.
    const toolCallAccumulator = new Map<
      number,
      { id: string; name: string; argsJson: string }
    >();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE format: lines starting with "data: "
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // keep the incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') {
            yield { kind: 'finish', reason: 'stop' };
            return;
          }
          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{
                delta?: {
                  content?: string;
                  tool_calls?: Array<{
                    index?: number;
                    id?: string;
                    type?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
                finish_reason?: string | null;
              }>;
              // Task G.4.2 — OpenAI-shaped usage payload, delivered by
              // providers that honor `stream_options.include_usage`.
              // Sits at the chunk root, not under `choices`. Typically
              // arrives once, in the chunk right before `[DONE]`.
              usage?: {
                prompt_tokens?: number;
                completion_tokens?: number;
                total_tokens?: number;
                // Cached-prompt tokens, reported two different ways:
                //   OpenAI / xAI / GLM: usage.prompt_tokens_details.cached_tokens
                //   DeepSeek:           usage.prompt_cache_hit_tokens
                prompt_tokens_details?: { cached_tokens?: number };
                prompt_cache_hit_tokens?: number;
              };
            };
            const choice = parsed.choices?.[0];
            const delta = choice?.delta;
            // Task G.4.2 — emit a `usage` delta whenever the provider
            // includes a usage payload on the chunk. We don't gate on
            // `choice.finish_reason` because some providers (xAI) send
            // the usage on a chunk whose choices array is empty.
            if (parsed.usage && typeof parsed.usage === 'object') {
              const promptTokens =
                typeof parsed.usage.prompt_tokens === 'number'
                  ? parsed.usage.prompt_tokens
                  : 0;
              const completionTokens =
                typeof parsed.usage.completion_tokens === 'number'
                  ? parsed.usage.completion_tokens
                  : 0;
              const totalTokens =
                typeof parsed.usage.total_tokens === 'number'
                  ? parsed.usage.total_tokens
                  : promptTokens + completionTokens;
              const cachedPromptTokens = parseCachedPromptTokens(parsed.usage);
              yield {
                kind: 'usage',
                usage: {
                  promptTokens,
                  completionTokens,
                  totalTokens,
                  ...(cachedPromptTokens > 0 ? { cachedPromptTokens } : {}),
                },
              };
            }
            if (typeof delta?.content === 'string' && delta.content.length > 0) {
              yield { kind: 'text', delta: delta.content };
            }
            // Chain-of-thought / reasoning channel. GLM, DeepSeek, Qwen and
            // MiniMax expose this separately from `content` so it never needs
            // to be scrubbed out of the visible message. Without this yield
            // the harness never emits a `thinking_delta` BrainEvent, the
            // desktop's thinking-render path stays dead, and reasoning either
            // leaks inline as <think> tags or is silently dropped.
            const reasoning =
              (delta as { reasoning_content?: unknown })?.reasoning_content ??
              (delta as { reasoning?: unknown })?.reasoning;
            if (typeof reasoning === 'string' && reasoning.length > 0) {
              yield { kind: 'thinking', delta: reasoning };
            }
            // OpenAI tool_calls are streamed incrementally — accumulate args
            // per index and emit a tool_call delta when the args JSON closes.
            if (Array.isArray(delta?.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                const existing = toolCallAccumulator.get(idx) ?? {
                  id: tc.id ?? '',
                  name: tc.function?.name ?? '',
                  argsJson: '',
                };
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name = tc.function.name;
                if (tc.function?.arguments) existing.argsJson += tc.function.arguments;
                toolCallAccumulator.set(idx, existing);
                // Heuristic: when argsJson parses as a complete JSON object, emit.
                if (existing.argsJson.trim().endsWith('}')) {
                  try {
                    const parsedArgs = JSON.parse(existing.argsJson);
                    toolCallAccumulator.delete(idx);
                    yield {
                      kind: 'tool_call',
                      toolCallId: existing.id || `tc-${idx}`,
                      toolName: existing.name,
                      args: parsedArgs,
                    };
                  } catch {
                    // JSON not closed yet — keep accumulating.
                  }
                }
              }
            }
            // Final chunk: if the provider includes a finish_reason, surface it
            // (especially 'tool_calls', which the harness uses to decide whether
            // to re-enter the provider after tool results are appended).
            if (choice?.finish_reason) {
              yield { kind: 'finish', reason: choice.finish_reason };
            }
          } catch {
            // Skip malformed lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  };
}

/**
 * Helper: read env + keyStore + providerConfig and return a configured
 * provider for the currently-active provider. Returns null if the API key
 * is missing (CLI will show a friendly error).
 *
 * Resolution order:
 *   1. ANATHEMA_ACTIVE_PROVIDER env (overrides everything)
 *   2. providerConfig.activeProviderId (Phase 15 persistent state)
 *   3. Default: 'openai-compatible'
 *
 * API key resolution (per providerId):
 *   1. {PROVIDER_UPPER}_API_KEY env (e.g. GROK_API_KEY)
 *   2. keyStore stored key (OAuth-aware via resolveApiKeyWithMeta)
 *      — this triggers auto-refresh when the token is near expiry (Task D.3.2)
 *
 * Base URL resolution (per providerId):
 *   - 'openai-compatible' / 'custom': OPENAI_BASE_URL env or default to api.x.ai
 *   - others: hardcoded PROVIDER_ENDPOINTS entry
 *
 * Model resolution:
 *   - OPENAI_MODEL env override (always wins)
 *   - providerConfig.modelByProvider[providerId]
 */
export async function providerFromEnv(): Promise<OpenAICompatibleConfig | null> {
  const providerId = resolveActiveProvider();
  const apiKey = await resolveApiKeyWithMeta(providerId);
  if (!apiKey) return null;
  return {
    apiKey: apiKey.apiKey,
    baseUrl: resolveBaseUrl(providerId),
    model: getModelForProvider(providerId),
    providerId,
  };
}

/**
 * Resolve a provider config explicitly for a given provider id. Useful
 * when the caller needs to switch providers at runtime (e.g. `/provider <name>`).
 *
 * Returns null if the API key for that provider is missing.
 */
export async function providerConfigFor(providerId: ProviderName): Promise<OpenAICompatibleConfig | null> {
  const apiKey = await resolveApiKeyWithMeta(providerId);
  if (!apiKey) return null;
  return {
    apiKey: apiKey.apiKey,
    baseUrl: resolveBaseUrl(providerId),
    model: getModelForProvider(providerId),
    providerId,
  };
}
