/**
 * llm/oneShot.ts — shared one-shot chat-completion helper.
 *
 * Extracted from generateSkillFromUrl.ts so the skill importer and the
 * automations runner issue identical LLM calls: resolve provider/model/key/
 * baseUrl like the interactive CLI, then one non-streaming POST to
 * `${baseUrl}/chat/completions`. Pure fetch, node stdlib only.
 */
import { getModelForProvider, getProviderConfig } from '../providerConfig.js';
import { resolveApiKeyWithMeta, type ProviderName } from '../keyStore.js';
import { resolveBaseUrl } from '../provider/openai-compatible.js';

/** Default wall-clock budget for one completion (ms). */
export const DEFAULT_LLM_TIMEOUT_MS = 120_000;

/** Resolved routing + credentials for a one-shot call. */
export interface LlmTarget {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

/** One completion request (system + user turns). */
export interface ChatRequest {
  system: string;
  user: string;
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
}

/** Token accounting, when the provider reports it. */
export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** A completed one-shot call. */
export interface ChatResult {
  text: string;
  usage?: ChatUsage;
}

/**
 * Resolve provider + model + credentials for a one-shot call.
 *
 * Provider default = the active provider; model default = the per-provider
 * model → `ZELARI_MODEL` env. Throws with human-clearable messages when the
 * API key, base URL or model cannot be resolved.
 */
export async function resolveLlm(opts: {
  provider?: string;
  model?: string;
}): Promise<LlmTarget> {
  const active = (opts.provider?.trim() ||
    getProviderConfig().activeProviderId) as ProviderName;
  const meta = await resolveApiKeyWithMeta(active);
  if (!meta?.apiKey) {
    throw new Error(
      `No API key for provider '${active}'. Save a key in Settings → Provider.`,
    );
  }
  const baseUrl = resolveBaseUrl(active);
  if (!baseUrl) {
    throw new Error(
      `No base URL for provider '${active}'. Set a custom endpoint in Settings.`,
    );
  }
  const model =
    opts.model?.trim() ||
    getModelForProvider(active) ||
    process.env.ZELARI_MODEL ||
    '';
  if (!model) {
    throw new Error(`No model selected for provider '${active}'`);
  }
  return { provider: active, model, apiKey: meta.apiKey, baseUrl };
}

/** Map the OpenAI wire `usage` object to `ChatUsage` (dropping absent fields). */
function mapUsage(raw?: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}): ChatUsage | undefined {
  if (!raw) return undefined;
  const out: ChatUsage = {};
  if (typeof raw.prompt_tokens === 'number') out.promptTokens = raw.prompt_tokens;
  if (typeof raw.completion_tokens === 'number') out.completionTokens = raw.completion_tokens;
  if (typeof raw.total_tokens === 'number') out.totalTokens = raw.total_tokens;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * One non-streaming chat completion. Throws on a non-2xx HTTP status (with the
 * status + a body slice) or when the model returns empty content.
 */
export async function chatCompletion(
  llm: LlmTarget,
  req: ChatRequest,
): Promise<ChatResult> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    req.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
  );
  try {
    const url = `${llm.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${llm.apiKey}`,
      },
      body: JSON.stringify({
        model: llm.model,
        temperature: req.temperature ?? 0.2,
        max_tokens: req.maxTokens ?? 4096,
        stream: false,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(
        `LLM HTTP ${res.status}${errBody ? `: ${errBody.slice(0, 200)}` : ''}`,
      );
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('Empty model response');
    return { text, usage: mapUsage(json.usage) };
  } finally {
    clearTimeout(timer);
  }
}
