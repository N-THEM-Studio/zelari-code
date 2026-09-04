/**
 * providerConfig — CLI provider runtime configuration.
 *
 * Persists the active provider id + per-provider default models to a JSON
 * file in the user's home directory. Complements `keyStore` (which stores
 * API keys) with the *routing* state: which provider the CLI should use
 * next, and which model to use for each one.
 *
 * Storage layout (alongside keyStore):
 *   ~/.zelari-code/
 *     keys.json              ← keyStore (Task 14.9)
 *     provider.json          ← this file (Task 15.1)
 *     sessions/<id>.jsonl
 *     branches/<name>/
 *
 * Pure node:fs — no Electron deps, browser-importable for jsdom tests.
 * Env override: `ANATHEMA_PROVIDER_CONFIG_FILE` (useful for tests + CI).
 *
 * @see docs/plans/ (v2 plan, 2026-06-29) (Task 15.1)
 */

import { promises as fs, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { providerConfigPath } from './paths.js';
import { PROVIDERS, type ProviderName, type ProviderSpec } from './keyStore.js';
import { parseThinkingSpec, stringifyThinkingSpec, type ThinkingSpec } from './thinking.js';

/** Persisted provider config (the on-disk shape). */
export interface ProviderConfig {
  /** Currently active provider id (must be one of PROVIDERS). */
  activeProviderId: ProviderName;
  /** Per-provider default model. Always contains an entry for every provider. */
  modelByProvider: Record<ProviderName, string>;
  /**
   * Per-provider thinking-effort spec (ADR-0017), stored as a canonical
   * string: 'auto' | 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'budget:<tokens>'.
   * Always contains an entry for every provider.
   */
  thinkingByProvider: Record<ProviderName, string>;
  /**
   * Custom base URLs keyed by provider id (Task A3, v3-A).
   * Lets users point `openai-compatible` or `custom` at any self-hosted
   * endpoint (Ollama, LM Studio, vLLM, etc.) without code changes.
   * Empty string = use built-in default for that provider.
   */
  customEndpoints: Partial<Record<ProviderName, string>>;
  /**
   * Kraken selection verifier override (Fase 9, ADR-0020).
   * ABSENT = `inherit` — the verifier uses the exact current run model
   * (the only default). Old config files without this field therefore
   * resolve to inherit automatically. Both provider AND model are
   * required; anything partial/unknown is dropped by the merge.
   */
  krakenVerifier?: { provider: ProviderName; model: string };
}

const DEFAULTS: ProviderConfig = {
  activeProviderId: 'openai-compatible',
  modelByProvider: {
    // grok-4.6: flagship; native reasoning_effort includes xhigh
    'openai-compatible': 'grok-4.6',
    'minimax': 'MiniMax-M2.5',
    'glm': 'glm-4.6',
    'grok': 'grok-4.6',
    'deepseek': 'deepseek-v4-pro',
    'chatgpt': 'gpt-5.6-codex',
    'anthropic': 'claude-sonnet-4-6',
    'custom': '',
  },
  thinkingByProvider: {
    'openai-compatible': 'auto',
    'minimax': 'auto',
    'glm': 'auto',
    'grok': 'auto',
    'deepseek': 'auto',
    'chatgpt': 'auto',
    'anthropic': 'auto',
    'custom': 'auto',
  },
  customEndpoints: {},
};

export function getProviderConfigPath(): string {
  return providerConfigPath();
}

/**
 * Sanitize a parsed (partial) on-disk config blob into a full ProviderConfig,
 * or clone the defaults when the blob is unusable. Shared by the sync
 * (getProviderConfig) and async (loadProviderConfig) paths so the two can
 * never diverge again (Exit-0 E0.1: the async path used to silently drop
 * krakenVerifier and skip env overrides on the fallback).
 */
function mergeStoredProviderConfig(parsed: Partial<ProviderConfig> | null | undefined): ProviderConfig {
  if (parsed && typeof parsed === 'object' && typeof parsed.activeProviderId === 'string'
    && parsed.modelByProvider && typeof parsed.modelByProvider === 'object') {
    return {
      activeProviderId: parsed.activeProviderId as ProviderName,
      modelByProvider: { ...DEFAULTS.modelByProvider, ...parsed.modelByProvider },
      thinkingByProvider: { ...DEFAULTS.thinkingByProvider, ...parsed.thinkingByProvider },
      customEndpoints: mergeCustomEndpoints(parsed.customEndpoints),
      krakenVerifier: mergeKrakenVerifier(parsed.krakenVerifier),
    };
  }
  return cloneDefaults();
}

/** Deep-enough clone of DEFAULTS (nested records are copied, never shared). */
function cloneDefaults(): ProviderConfig {
  return {
    ...DEFAULTS,
    modelByProvider: { ...DEFAULTS.modelByProvider },
    thinkingByProvider: { ...DEFAULTS.thinkingByProvider },
    customEndpoints: { ...DEFAULTS.customEndpoints },
  };
}

/**
 * Apply env overrides (ANATHEMA_ACTIVE_PROVIDER, OPENAI_MODEL) on top of a
 * resolved config — always last, so env wins over both file and defaults.
 * Shared by sync and async paths (Exit-0 E0.1).
 */
function applyEnvOverrides(config: ProviderConfig): ProviderConfig {
  const envActive = process.env.ANATHEMA_ACTIVE_PROVIDER;
  const envModel = process.env.OPENAI_MODEL;
  if (envActive && PROVIDERS.some((p) => p.id === envActive)) {
    config.activeProviderId = envActive as ProviderName;
  }
  if (envModel && envModel.trim().length > 0) {
    config.modelByProvider[config.activeProviderId] = envModel;
  }
  return config;
}

/** Return the resolved ProviderConfig (env override > on-disk > defaults). */
export function getProviderConfig(): ProviderConfig {
  const file = getProviderConfigPath();
  let parsed: Partial<ProviderConfig> | null = null;
  if (existsSync(file)) {
    try {
      parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<ProviderConfig>;
    } catch {
      // Corrupt file — fall through to defaults.
    }
  }
  return applyEnvOverrides(mergeStoredProviderConfig(parsed));
}

function writeProviderConfig(config: ProviderConfig): void {
  const file = getProviderConfigPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Sanitize a parsed `customEndpoints` blob into a clean
 * `Partial<Record<ProviderName, string>>`. Drops non-string values,
 * non-ProviderName keys, and empty / whitespace-only URLs.
 */
function mergeCustomEndpoints(
  raw: Partial<Record<ProviderName, string>> | undefined,
): Partial<Record<ProviderName, string>> {
  if (!raw || typeof raw !== 'object') return {};
  const result: Partial<Record<ProviderName, string>> = {};
  const validIds = new Set<string>(PROVIDERS.map((p) => p.id));
  for (const [key, value] of Object.entries(raw)) {
    if (!validIds.has(key)) continue;
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    result[key as ProviderName] = trimmed;
  }
  return result;
}

/** Return the resolved custom endpoint for a provider, or undefined. */
export function getCustomEndpoint(id: ProviderName): string | undefined {
  return getProviderConfig().customEndpoints[id];
}

/**
 * Save a custom base URL for a provider. Validates the URL is parseable.
 * Empty string is rejected — use `clearCustomEndpoint()` to remove.
 */
export function setCustomEndpoint(id: ProviderName, url: string): void {
  const spec: ProviderSpec | undefined = PROVIDERS.find((p) => p.id === id);
  if (!spec) {
    throw new Error(`Unknown provider id: "${id}". Available: ${PROVIDERS.map((p) => p.id).join(', ')}`);
  }
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    throw new Error('Custom endpoint URL cannot be empty. Use clearCustomEndpoint() to remove.');
  }
  try {
    // eslint-disable-next-line no-new
    new URL(trimmed);
  } catch {
    throw new Error(`Invalid custom endpoint URL: "${url}"`);
  }
  const config = getProviderConfig();
  config.customEndpoints[id] = trimmed;
  writeProviderConfig(config);
}

/** Remove the custom base URL override for a provider (falls back to default). */
export function clearCustomEndpoint(id: ProviderName): void {
  const spec: ProviderSpec | undefined = PROVIDERS.find((p) => p.id === id);
  if (!spec) {
    throw new Error(`Unknown provider id: "${id}". Available: ${PROVIDERS.map((p) => p.id).join(', ')}`);
  }
  const config = getProviderConfig();
  if (!(id in config.customEndpoints)) return; // no-op
  delete config.customEndpoints[id];
  writeProviderConfig(config);
}

/**
 * Sanitize a parsed `krakenVerifier` blob. Drops anything that is not a
 * complete, valid override (both provider+model, known provider,
 * non-empty model) so a hand-edited/corrupt file falls back to inherit
 * instead of breaking verifier resolution.
 */
function mergeKrakenVerifier(
  raw: { provider?: unknown; model?: unknown } | undefined,
): { provider: ProviderName; model: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  if (!provider || !model) return undefined;
  if (!PROVIDERS.some((p) => p.id === provider)) return undefined;
  return { provider: provider as ProviderName, model };
}

/**
 * Persisted verifier override, or undefined = inherit (default).
 * Structurally compatible with KrakenVerifierOverride (verifier.ts).
 */
export function getKrakenVerifierOverride():
  | { provider: ProviderName; model: string }
  | undefined {
  return getProviderConfig().krakenVerifier;
}

/** Set an explicit Kraken verifier (both provider and model required). */
export function setKrakenVerifier(provider: string, model: string): void {
  const spec: ProviderSpec | undefined = PROVIDERS.find((p) => p.id === provider);
  if (!spec) {
    throw new Error(`Unknown provider id: "${provider}". Available: ${PROVIDERS.map((p) => p.id).join(', ')}`);
  }
  if (!model || model.trim().length === 0) {
    throw new Error('Verifier model cannot be empty. Use clearKrakenVerifier() to inherit.');
  }
  const config = getProviderConfig();
  config.krakenVerifier = { provider: provider as ProviderName, model: model.trim() };
  writeProviderConfig(config);
}

/** Remove the verifier override — back to `inherit` (same as current model). */
export function clearKrakenVerifier(): void {
  const config = getProviderConfig();
  if (!config.krakenVerifier) return; // no-op
  delete config.krakenVerifier;
  writeProviderConfig(config);
}

export function setActiveProviderId(id: ProviderName): void {
  const spec: ProviderSpec | undefined = PROVIDERS.find((p) => p.id === id);
  if (!spec) {
    throw new Error(`Unknown provider id: "${id}". Available: ${PROVIDERS.map((p) => p.id).join(', ')}`);
  }
  const config = getProviderConfig();
  config.activeProviderId = id;
  // Ensure the model entry exists for the new provider.
  if (!config.modelByProvider[id]) {
    config.modelByProvider[id] = DEFAULTS.modelByProvider[id];
  }
  writeProviderConfig(config);
}

export function setModelForProvider(id: ProviderName, model: string): void {
  const spec: ProviderSpec | undefined = PROVIDERS.find((p) => p.id === id);
  if (!spec) {
    throw new Error(`Unknown provider id: "${id}". Available: ${PROVIDERS.map((p) => p.id).join(', ')}`);
  }
  if (!model || model.trim().length === 0) {
    throw new Error('Model name cannot be empty.');
  }
  const config = getProviderConfig();
  config.modelByProvider[id] = model.trim();
  writeProviderConfig(config);
}

export function getModelForProvider(id: ProviderName): string {
  const config = getProviderConfig();
  return config.modelByProvider[id] ?? DEFAULTS.modelByProvider[id] ?? '';
}

/** Return the parsed thinking-effort spec for a provider (default 'auto'). */
export function getThinkingForProvider(id: ProviderName): ThinkingSpec {
  const config = getProviderConfig();
  return parseThinkingSpec(config.thinkingByProvider[id]);
}

/** Persist a thinking-effort spec for a provider (canonical string form). */
export function setThinkingForProvider(id: ProviderName, spec: ThinkingSpec): void {
  const found = PROVIDERS.find((p) => p.id === id);
  if (!found) {
    throw new Error(`Unknown provider id: "${id}". Available: ${PROVIDERS.map((p) => p.id).join(', ')}`);
  }
  const config = getProviderConfig();
  config.thinkingByProvider[id] = stringifyThinkingSpec(spec);
  writeProviderConfig(config);
}

export function getActiveProvider(): ProviderSpec {
  const config = getProviderConfig();
  const spec = PROVIDERS.find((p) => p.id === config.activeProviderId);
  // activeProviderId is validated at write time, so spec is always defined.
  if (!spec) throw new Error(`Invalid active provider id in config: ${config.activeProviderId}`);
  return spec;
}

export function getActiveModel(): string {
  const config = getProviderConfig();
  return config.modelByProvider[config.activeProviderId] ?? DEFAULTS.modelByProvider[config.activeProviderId] ?? '';
}

/**
 * Async variant of getProviderConfig (used by tests + CLI startup).
 * Delegates to the exact same merge/env logic as the sync path (Exit-0 E0.1):
 * round-trip parity is guaranteed — krakenVerifier, custom endpoints and
 * env overrides survive an async load exactly like a sync one.
 */
export async function loadProviderConfig(): Promise<ProviderConfig> {
  const file = getProviderConfigPath();
  let parsed: Partial<ProviderConfig> | null = null;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as Partial<ProviderConfig>;
  } catch {
    // ENOENT or JSON parse failure — fall back to defaults.
  }
  return applyEnvOverrides(mergeStoredProviderConfig(parsed));
}