/**
 * Optional LLM pass for history compaction summaries.
 * Falls back to null on any failure so callers use extractive summary.
 *
 * Disable with ZELARI_LLM_COMPACT=0.
 *
 * @since v1.21.0
 */
import {
  getModelForProvider,
  getProviderConfig,
  getCustomEndpoint,
} from '../providerConfig.js';
import { resolveApiKeyWithMeta } from '../keyStore.js';
import {
  PROVIDER_ENDPOINTS,
  type OpenAICompatibleConfig,
} from '../provider/openai-compatible.js';
import type { ProviderName } from '../keyStore.js';

const COMPACT_SYSTEM = `You compress earlier turns of a coding-agent session into a dense continuity brief.
Output plain text (no markdown fences) with these sections:
1) Goal — what the user wants
2) Decisions — choices already made
3) Done — completed work / files changed
4) Open — remaining tasks / blockers
5) Constraints — important rules the agent must keep

Be factual and concise. Max ~400 words. Do not invent work that was not present.`;

export function isLlmCompactEnabled(): boolean {
  const v = process.env.ZELARI_LLM_COMPACT?.trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  // default on when env unset
  return true;
}

/**
 * Ask the active provider for a continuity summary.
 * Returns null if disabled, no key, or request fails.
 */
export async function llmSummarizeHistory(input: {
  extractive: string;
  droppedTranscript: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  if (!isLlmCompactEnabled()) return null;
  if (!input.droppedTranscript.trim()) return null;

  let config: OpenAICompatibleConfig | null = null;
  try {
    config = await resolveCompactProviderConfig();
  } catch {
    return null;
  }
  if (!config) return null;

  const model =
    process.env.ZELARI_COMPACT_MODEL?.trim() || config.model;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  const onOuterAbort = () => controller.abort();
  input.signal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 900,
        stream: false,
        messages: [
          { role: 'system', content: COMPACT_SYSTEM },
          {
            role: 'user',
            content:
              `Extractive sketch (may be incomplete):\n${input.extractive.slice(0, 2_500)}\n\n` +
              `Transcript of dropped turns:\n${input.droppedTranscript}`,
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) return null;
    return (
      '[history-summary · llm]\n' +
      text +
      '\n\nContinue from the recent messages below; honor decisions already made above.'
    );
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', onOuterAbort);
  }
}

async function resolveCompactProviderConfig(): Promise<OpenAICompatibleConfig | null> {
  const active = getProviderConfig().activeProviderId as ProviderName;
  const meta = await resolveApiKeyWithMeta(active);
  const apiKey = meta?.apiKey;
  if (!apiKey) return null;

  const custom = getCustomEndpoint(active);
  let baseUrl =
    custom ||
    (active === 'openai-compatible' || active === 'custom'
      ? process.env.OPENAI_BASE_URL ?? PROVIDER_ENDPOINTS[active]
      : PROVIDER_ENDPOINTS[active]);
  if (!baseUrl) return null;

  const model = getModelForProvider(active);
  return {
    apiKey,
    baseUrl,
    model,
    providerId: active,
  };
}
