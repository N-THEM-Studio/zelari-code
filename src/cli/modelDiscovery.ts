/**
 * modelDiscovery — auto-discover available models for each provider.
 *
 * Triggers:
 *   - After `/login <provider> <key>` succeeds (keyStore write)
 *   - After `/login grok` (OAuth) succeeds
 *   - On user request via `/model refresh` or `/models refresh`
 *   - On startup if cache is older than `staleAfterMs` (default 6h)
 *
 * Why dynamic discovery? Providers (xAI, Z.AI, MiniMax, OpenAI) add/remove
 * models frequently — hardcoding a list in `providerDefaults` makes the user
 * see stale choices. After auth we hit the provider's `/v1/models` endpoint
 * and cache the IDs in `~/.tmp/anathema-coder/models.json`.
 *
 * Pure node:fs + fetch — no Electron deps, browser-importable for jsdom tests.
 * Env override: `ANATHEMA_MODELS_FILE` (useful for tests + CI).
 *
 * @see docs/plans/2026-06-30-anathema-coder-v3-U.md
 */

import { promises as fs, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderId = 'grok' | 'glm' | 'minimax' | 'deepseek' | 'openai-compatible';

export interface DiscoveredModel {
  /** Model id (e.g. 'grok-4-fast-reasoning', 'glm-4.6'). */
  id: string;
  /** Display name (e.g. 'Grok 4 Fast Reasoning'). Falls back to id. */
  displayName?: string;
  /** Provider-reported creation timestamp (epoch seconds). */
  created?: number;
  /** Owner reported by provider (e.g. 'xai', 'openai'). */
  ownedBy?: string;
  /** Optional context window in tokens (parsed from `context_length` if present). */
  contextLength?: number;
}

export interface ProviderModelsEntry {
  /** Array of discovered models (sorted by id). */
  models: DiscoveredModel[];
  /** Epoch ms when the list was fetched. */
  fetchedAt: number;
  /** The base URL used for the discovery call. */
  baseUrl: string;
  /** Optional error from the last fetch (e.g. stale cache after a failed refresh). */
  lastError?: string;
}

export interface ModelsRegistry {
  grok?: ProviderModelsEntry;
  glm?: ProviderModelsEntry;
  minimax?: ProviderModelsEntry;
  deepseek?: ProviderModelsEntry;
  'openai-compatible'?: ProviderModelsEntry;
}

export interface DiscoverOptions {
  /** Override the fetch implementation (used in tests). */
  fetchImpl?: typeof fetch;
  /** Override the base URL for the provider (default: provider default). */
  baseUrl?: string;
  /** Bearer token to use (defaults: API key from keyStore for non-grok, OAuth token for grok). */
  authToken?: string;
  /** Skip cache write (default: false). */
  skipCacheWrite?: boolean;
}

// ---------------------------------------------------------------------------
// Provider endpoint map
// ---------------------------------------------------------------------------

/**
 * Default base URL per provider for `/v1/models` discovery.
 *
 * NOTE: `openai-compatible` defaults to api.x.ai/v1 to match the chat default
 * in `provider/openai-compatible.ts` (PROVIDER_ENDPOINTS). Discovery and chat
 * must agree on the base URL, otherwise `/models refresh` would probe a
 * different host than the one prompts are sent to.
 */
const PROVIDER_BASE_URLS: Record<ProviderId, string> = {
  'grok': 'https://api.x.ai/v1',
  // Must match PROVIDER_ENDPOINTS in provider/openai-compatible.ts (chat host).
  'glm': 'https://api.z.ai/api/coding/paas/v4',
  'minimax': 'https://api.minimax.io/v1',
  // Must match PROVIDER_ENDPOINTS in provider/openai-compatible.ts (chat host).
  'deepseek': 'https://api.deepseek.com',
  'openai-compatible': 'https://api.x.ai/v1',
};

/**
 * Resolve the base URL for a discovery call, mirroring chat's `resolveBaseUrl`
 * (provider/openai-compatible.ts) so `/models` is fetched from the same host
 * that prompts hit. Priority:
 *   1. Explicit `options.baseUrl` (used by tests)
 *   2. Custom endpoint persisted via `/provider custom <url>` (wins always)
 *   3. OPENAI_BASE_URL env override (for openai-compatible)
 *   4. Static PROVIDER_BASE_URLS default for that provider
 *
 * Uses a late import of providerConfig (node:fs only) to keep this module
 * browser-importable for jsdom tests, matching `resolveAuthToken`.
 */
async function resolveDiscoveryBaseUrl(
  provider: ProviderId,
  options: { baseUrl?: string }
): Promise<string> {
  if (options.baseUrl) return options.baseUrl;
  const { getCustomEndpoint } = await import('./providerConfig.js');
  const custom = getCustomEndpoint(provider);
  if (custom) return custom;
  if (provider === 'openai-compatible') {
    const envBase = process.env.OPENAI_BASE_URL;
    if (envBase && envBase.trim().length > 0) return envBase;
  }
  return PROVIDER_BASE_URLS[provider];
}

// ---------------------------------------------------------------------------
// Cache file location
// ---------------------------------------------------------------------------

function defaultModelsFilePath(): string {
  return process.env.ANATHEMA_MODELS_FILE
    ?? path.join(homedir(), '.tmp', 'zelari-code', 'models.json');
}

export function getModelsFilePath(): string {
  return defaultModelsFilePath();
}

// ---------------------------------------------------------------------------
// Sync read (used at app start)
// ---------------------------------------------------------------------------

/** Read the on-disk models registry. Returns empty object if file missing/corrupt. */
export function loadModelsRegistry(file: string = getModelsFilePath()): ModelsRegistry {
  if (!existsSync(file)) return {};
  try {
    const raw = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as ModelsRegistry;
  } catch {
    return {};
  }
}

/** Read cached models for a single provider. Returns undefined if not cached. */
export function getCachedModels(
  provider: ProviderId,
  file: string = getModelsFilePath()
): ProviderModelsEntry | undefined {
  const registry = loadModelsRegistry(file);
  return registry[provider];
}

/** Returns true if the cache exists and is older than `maxAgeMs`. */
export function isModelsCacheStale(
  provider: ProviderId,
  maxAgeMs: number = 6 * 60 * 60 * 1000, // 6 hours
  file: string = getModelsFilePath(),
  now: number = Date.now()
): boolean {
  const entry = getCachedModels(provider, file);
  if (!entry) return true;
  return (now - entry.fetchedAt) > maxAgeMs;
}

// ---------------------------------------------------------------------------
// Async write (atomic: write to .tmp, rename) — serialized via in-memory mutex
// to avoid concurrent discoveries clobbering each other (race on rename).
// Also wraps the read-modify-write cycle so two parallel calls don't both
// observe an empty registry and then clobber each other.
// ---------------------------------------------------------------------------

let writeChain: Promise<unknown> = Promise.resolve();

async function withRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(async () => fn());
  writeChain = next.catch(() => undefined);
  return next;
}

async function readModifyWriteRegistry(
  mutator: (current: ModelsRegistry) => ModelsRegistry,
  file: string = getModelsFilePath()
): Promise<ModelsRegistry> {
  return withRegistryLock(async () => {
    // Read latest on-disk (other concurrent calls may have written since
    // we last read).
    const onDisk = loadModelsRegistry(file);
    const merged = mutator(onDisk);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(merged, null, 2), 'utf-8');
    await fs.rename(tmp, file);
    return merged;
  });
}

// ---------------------------------------------------------------------------
// Auth resolution
// ---------------------------------------------------------------------------

/** Synchronous auth resolution — reads keyStore via dynamic import to keep this module browser-friendly. */
async function resolveAuthToken(
  provider: ProviderId,
  options: { authToken?: string }
): Promise<string | undefined> {
  if (options.authToken) return options.authToken;
  // Late import: keyStore uses node:fs/promises, no Electron deps.
  const { resolveApiKeyWithMeta, getOAuthToken } = await import('./keyStore.js');
  if (provider === 'grok') {
    const oauth = getOAuthToken('grok');
    if (oauth?.apiKey) return oauth.apiKey;
  }
  const resolved = await resolveApiKeyWithMeta(provider);
  return resolved?.apiKey;
}

// ---------------------------------------------------------------------------
// /v1/models response parsing (OpenAI-compat schema)
// ---------------------------------------------------------------------------

interface OpenAIModelsResponse {
  object: 'list';
  data: Array<{
    id: string;
    object?: 'model';
    created?: number;
    owned_by?: string;
    [extra: string]: unknown;
  }>;
}

function parseOpenAIModelsResponse(json: unknown, baseUrl: string): DiscoveredModel[] {
  if (!json || typeof json !== 'object') return [];
  const obj = json as Partial<OpenAIModelsResponse>;
  if (!Array.isArray(obj.data)) return [];
  const models: DiscoveredModel[] = [];
  for (const m of obj.data) {
    if (!m || typeof m.id !== 'string') continue;
    const out: DiscoveredModel = { id: m.id };
    if (typeof m.created === 'number') out.created = m.created;
    if (typeof m.owned_by === 'string') out.ownedBy = m.owned_by;
    // Optional context length (some providers include it as extra field)
    const ctx = (m as Record<string, unknown>).context_length;
    if (typeof ctx === 'number') out.contextLength = ctx;
    models.push(out);
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

// ---------------------------------------------------------------------------
// Main: discoverModelsForProvider
// ---------------------------------------------------------------------------

/**
 * Fetch available models for a provider and persist the result to disk.
 * Throws on network errors but never corrupts the on-disk cache.
 */
export async function discoverModelsForProvider(
  provider: ProviderId,
  options: DiscoverOptions = {}
): Promise<ProviderModelsEntry> {
  const baseUrl = await resolveDiscoveryBaseUrl(provider, options);
  if (!baseUrl || baseUrl.trim().length === 0) {
    throw new ModelDiscoveryError(
      `No base URL for provider "${provider}" — set one with /provider custom <url> before discovering models`,
      'no_base_url'
    );
  }
  const url = `${baseUrl.replace(/\/$/, '')}/models`;
  const authToken = await resolveAuthToken(provider, options);

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    response = await fetchImpl(url, { method: 'GET', headers });
  } catch (err) {
    throw new ModelDiscoveryError(
      `Network error contacting ${url}: ${err instanceof Error ? err.message : String(err)}`,
      'network_error'
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ModelDiscoveryError(
      `HTTP ${response.status} from ${url}: ${body.slice(0, 200)}`,
      `http_${response.status}`
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    throw new ModelDiscoveryError(
      `Invalid JSON from ${url}: ${err instanceof Error ? err.message : String(err)}`,
      'invalid_json'
    );
  }

  const models = parseOpenAIModelsResponse(json, baseUrl);
  if (models.length === 0) {
    throw new ModelDiscoveryError(
      `Provider ${provider} returned 0 models — refusing to overwrite cache`,
      'empty_response'
    );
  }

  const entry: ProviderModelsEntry = {
    models,
    fetchedAt: Date.now(),
    baseUrl,
  };

  if (!options.skipCacheWrite) {
    const file = getModelsFilePath();
    await readModifyWriteRegistry((current) => {
      current[provider] = entry;
      return current;
    }, file);
  }

  return entry;
}

/**
 * Fire-and-forget variant: kicks off discovery in the background, logs errors
 * to the `onError` callback instead of throwing. Used by `/login` handlers
 * that must not block the user response on a slow `/v1/models` call.
 */
export function discoverModelsInBackground(
  provider: ProviderId,
  options: DiscoverOptions & { onError?: (err: ModelDiscoveryError) => void } = {}
): void {
  discoverModelsForProvider(provider, options).catch((err) => {
    if (err instanceof ModelDiscoveryError && options.onError) {
      options.onError(err);
    }
  });
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class ModelDiscoveryError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'ModelDiscoveryError';
  }
}

// ---------------------------------------------------------------------------
// Suggestion helper: filter /model tab-completion against discovered models
// ---------------------------------------------------------------------------

/** Returns the discovered model ids for a provider, or undefined if no cache. */
export function getDiscoveredModelIds(
  provider: ProviderId,
  file: string = getModelsFilePath()
): string[] | undefined {
  const entry = getCachedModels(provider, file);
  return entry?.models.map((m) => m.id);
}

/** Returns the "best" default model id: discovered (most recent) → providerDefaults fallback. */
export function pickDefaultModel(
  provider: ProviderId,
  providerDefaults: Partial<Record<ProviderId, string>>,
  file: string = getModelsFilePath()
): string | undefined {
  const cached = getCachedModels(provider, file);
  if (cached && cached.models.length > 0) {
    // Prefer the first model alphabetically that contains "latest" or matches the default name
    const preferred = cached.models.find((m) => /latest|default|chat/i.test(m.id));
    if (preferred) return preferred.id;
    return cached.models[0]?.id;
  }
  return providerDefaults[provider];
}