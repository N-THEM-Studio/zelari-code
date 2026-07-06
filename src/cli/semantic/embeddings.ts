/**
 * semantic/embeddings — call an OpenAI-compatible `/embeddings` endpoint.
 *
 * Reuses the active provider's base URL + API key (the same ones chat uses).
 * Not every provider exposes embeddings, so this is best-effort: any failure
 * (missing endpoint, HTTP error, bad shape) resolves to `{ error }` and the
 * caller degrades gracefully. The fetch is injectable for tests.
 */

export interface EmbedConfig {
  apiKey: string;
  baseUrl: string;
  /** Embedding model id (e.g. 'text-embedding-3-small'). */
  model: string;
}

export type EmbedResult = { embeddings: number[][] } | { error: string };

/** Parse an OpenAI-compatible embeddings response into ordered vectors. */
export function parseEmbeddingsResponse(json: unknown, expected: number): number[][] | null {
  if (!json || typeof json !== 'object') return null;
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const rows: Array<{ index: number; embedding: number[] }> = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const it = item as { index?: unknown; embedding?: unknown };
    if (!Array.isArray(it.embedding)) continue;
    const embedding = it.embedding.filter((n): n is number => typeof n === 'number');
    if (embedding.length === 0) continue;
    rows.push({ index: typeof it.index === 'number' ? it.index : rows.length, embedding });
  }
  if (rows.length === 0) return null;
  // Respect the provider-reported order.
  rows.sort((a, b) => a.index - b.index);
  const out = rows.map((r) => r.embedding);
  // Only accept a full result — a partial batch would misalign chunks.
  return out.length === expected ? out : null;
}

/** Embed a batch of texts. Never throws. */
export async function embedTexts(
  texts: string[],
  config: EmbedConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<EmbedResult> {
  if (texts.length === 0) return { embeddings: [] };
  const url = `${config.baseUrl.replace(/\/$/, '')}/embeddings`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ model: config.model, input: texts }),
    });
  } catch (err) {
    return { error: `network error contacting ${url}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return { error: `HTTP ${response.status} from ${url}: ${body.slice(0, 160)}` };
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    return { error: `invalid JSON from ${url}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const embeddings = parseEmbeddingsResponse(json, texts.length);
  if (!embeddings) return { error: `unexpected embeddings response shape from ${url}` };
  return { embeddings };
}
