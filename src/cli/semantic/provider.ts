/**
 * semantic/provider — build an EmbedFn from the active chat provider.
 *
 * Reuses the same base URL + API key resolution as chat (providerFromEnv), so
 * `/index` and `semantic_search` hit the provider the user is already logged
 * into. The embedding model is configurable via ZELARI_EMBED_MODEL.
 */

import { providerFromEnv } from '../provider/openai-compatible.js';
import { embedTexts } from './embeddings.js';
import type { EmbedFn } from './index.js';

export const DEFAULT_EMBED_MODEL = 'text-embedding-3-small';

export function embedModel(): string {
  return process.env.ZELARI_EMBED_MODEL ?? DEFAULT_EMBED_MODEL;
}

/**
 * Build an EmbedFn bound to the active provider, or null if no provider/API
 * key is configured. The returned fn normalizes embedTexts' result shape into
 * the `number[][] | { error }` the index expects.
 */
export async function buildProviderEmbedFn(): Promise<EmbedFn | null> {
  const cfg = await providerFromEnv();
  if (!cfg) return null;
  const embedCfg = { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: embedModel() };
  return async (texts: string[]) => {
    const res = await embedTexts(texts, embedCfg);
    return 'error' in res ? { error: res.error } : res.embeddings;
  };
}
