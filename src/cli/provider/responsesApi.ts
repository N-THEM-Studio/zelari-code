/**
 * OpenAI Responses API transport for OpenAI-compatible providers.
 *
 * Any provider routed through `openaiCompatibleProvider` (openai-compatible,
 * custom, grok, glm, minimax, deepseek) can be switched to the Responses API
 * (`POST {baseUrl}/responses`) with `/provider api responses`. Selection is
 * persisted per-provider in providerConfig (`apiStyleByProvider`) and applied
 * by `resolveStream.buildProviderStream`.
 *
 * Differences from the ChatGPT OAuth transport (`chatgpt.ts`):
 *   - Plain `Authorization: Bearer <apiKey>` (no ChatGPT-Account-Id /
 *     OpenAI-Beta headers — those stay exclusive to the OAuth flow).
 *   - baseUrl comes from the resolved provider endpoint (custom endpoint /
 *     OPENAI_BASE_URL already work through `resolveBaseUrl`).
 *   - Sends `temperature` and `max_output_tokens` from the capability
 *     profile + per-request generation overrides.
 *   - Transient retry (429/5xx/network) with exponential backoff, same
 *     policy as openai-compatible.ts.
 *
 * Message mapping (`toInput`, chatgpt.ts) and the SSE event loop
 * (`readResponsesSse`, responsesSse.ts) are shared with chatgpt.ts — the
 * Responses wire format is identical.
 */

import type { ProviderDelta, ProviderStreamFn } from '@zelari/core/harness';
import { type OpenAICompatibleConfig, PROVIDER_CONNECT_TIMEOUT_MS } from './openai-compatible.js';
import { toInput } from './chatgpt.js';
import { readResponsesSse } from './responsesSse.js';
import { translateResponsesThinking } from '../thinking.js';
import { capabilitiesFor } from './capabilities.js';

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES: number = (() => {
  const raw = process.env.ZELARI_PROVIDER_MAX_RETRIES;
  const n = raw ? Number.parseInt(raw, 10) : 3;
  return Number.isFinite(n) && n >= 0 ? n : 3;
})();
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8000;

function backoffDelay(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number.parseFloat(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, BACKOFF_CAP_MS);
    }
  }
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
}

/** Sleep that resolves early when the caller's signal fires. */
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

function headers(config: OpenAICompatibleConfig): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Authorization: `Bearer ${config.apiKey}`,
  };
  if (config.extraHeaders) Object.assign(h, config.extraHeaders);
  return h;
}

export function responsesApiProvider(config: OpenAICompatibleConfig): ProviderStreamFn {
  return async function* (params): AsyncIterable<ProviderDelta> {
    const capabilities = capabilitiesFor(params.model, config.providerId);
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
    // Sampling params mirror openai-compatible.ts: per-request generation
    // overrides win, else the capability-profile defaults.
    const generation = params.generation;
    body.temperature = generation?.temperature ?? capabilities.sampling.temperature;
    const maxTokens = generation?.maxTokens ?? capabilities.maxOutputTokens;
    if (typeof maxTokens === 'number' && maxTokens > 0) {
      body.max_output_tokens = maxTokens;
    }

    // Unified thinking-effort selection (ADR-0017). The provider id drives
    // the clamp ladder so 'max' survives on openai-compatible / custom.
    const thinkingSpec = config.thinking ?? 'auto';
    if (thinkingSpec !== 'auto') {
      const t = translateResponsesThinking(thinkingSpec, config.model, config.providerId);
      if (t.degraded) {
        console.warn(`[thinking] ${t.note ?? 'unsupported'} — falling back to provider default.`);
      } else {
        Object.assign(body, t.patch);
      }
    }

    const base = config.baseUrl.replace(/\/$/, '');
    const url = `${base}/responses`;

    let response: Response | undefined;
    let lastStatus = 0;
    let lastErrText = '';
    for (let attempt = 0; ; attempt++) {
      // CONNECT-only timeout (policy identical to openai-compatible.ts).
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
      } catch (err) {
        lastStatus = 0;
        lastErrText = err instanceof Error ? err.message : String(err);
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
      } finally {
        clearTimeout(connectTimer);
      }
      if (response.ok && response.body) break;
      lastStatus = response.status;
      lastErrText = await response.text().catch(() => '');
      if (!RETRYABLE_STATUSES.has(response.status) || attempt >= MAX_RETRIES) break;
      await abortableSleep(backoffDelay(attempt, response.headers.get('retry-after')), params.signal);
      if (params.signal?.aborted) {
        yield { kind: 'error', message: 'aborted' };
        return;
      }
    }

    if (!response || !response.ok || !response.body) {
      const msg =
        lastStatus === 0
          ? `Network error: ${lastErrText}`
          : `HTTP ${lastStatus}: ${lastErrText.slice(0, 240)}`;
      yield { kind: 'error', message: msg };
      return;
    }

    // SSE event loop shared with chatgpt.ts (same wire format).
    yield* readResponsesSse(response.body, {
      signal: params.signal,
      tools: params.tools,
      label: `responses:${config.providerId}`,
    });
  };
}
