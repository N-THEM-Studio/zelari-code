/**
 * One-shot non-streaming JSON completion for Gauntlet decompose.
 * Fail-fast (default 60s): a slow reasoner must not stall the loop —
 * the caller falls back to a single piece.
 */
import { getModelForProvider, getProviderConfig } from '../providerConfig.js';
import { resolveApiKeyWithMeta, type ProviderName } from '../keyStore.js';
import { resolveBaseUrl } from '../provider/openai-compatible.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 2048;

function timeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ZELARI_GAUNTLET_DECOMPOSE_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TIMEOUT_MS;
}

export async function gauntletComplete(
  args: { system: string; user: string },
  opts: { provider: string; model: string; signal?: AbortSignal },
): Promise<string> {
  const provider = opts.provider as ProviderName;
  const meta = await resolveApiKeyWithMeta(provider);
  if (!meta?.apiKey) {
    throw new Error(`No API key for provider '${provider}'`);
  }
  const baseUrl = resolveBaseUrl(provider);
  if (!baseUrl) {
    throw new Error(`No base URL for provider '${provider}'`);
  }
  const model =
    process.env.ZELARI_KRAKEN_PLANNER_MODEL?.trim() ||
    opts.model ||
    getModelForProvider(provider) ||
    getProviderConfig().modelByProvider[provider] ||
    '';
  if (!model) throw new Error(`No model for provider '${provider}'`);

  const ms = timeoutMs();
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort();
  opts.signal?.addEventListener('abort', onParentAbort, { once: true });
  let timedOut = false;
  const timer =
    ms > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, ms)
      : undefined;
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${meta.apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: DEFAULT_MAX_TOKENS,
        stream: false,
        messages: [
          { role: 'system', content: args.system },
          { role: 'user', content: args.user },
        ],
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`decompose HTTP ${res.status}${errBody ? `: ${errBody.slice(0, 160)}` : ''}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
    };
    const msg = json.choices?.[0]?.message;
    const text = msg?.content?.trim() || msg?.reasoning_content?.trim() || '';
    if (!text) throw new Error('decompose: empty model response');
    return text;
  } catch (err) {
    if (timedOut) {
      throw new Error(
        `decompose timed out after ${Math.round(ms / 1000)}s — using a single piece. ` +
          'Raise ZELARI_GAUNTLET_DECOMPOSE_TIMEOUT_MS or set ZELARI_KRAKEN_PLANNER_MODEL to a fast model.',
      );
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onParentAbort);
  }
}
