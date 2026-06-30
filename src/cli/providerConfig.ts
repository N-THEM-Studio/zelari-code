/**
 * providerConfig — CLI provider runtime configuration.
 *
 * Persists the active provider id + per-provider default models to a JSON
 * file in the user's home directory. Complements `keyStore` (which stores
 * API keys) with the *routing* state: which provider the CLI should use
 * next, and which model to use for each one.
 *
 * Storage layout (alongside keyStore):
 *   ~/.tmp/anathema-coder/
 *     keys.json              ← keyStore (Task 14.9)
 *     provider.json          ← this file (Task 15.1)
 *     sessions/<id>.jsonl
 *     branches/<name>/
 *
 * Pure node:fs — no Electron deps, browser-importable for jsdom tests.
 * Env override: `ANATHEMA_PROVIDER_CONFIG_FILE` (useful for tests + CI).
 *
 * @see docs/plans/2026-06-29-anathema-coder-v2.md (Task 15.1)
 */

import { promises as fs, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PROVIDERS, type ProviderName, type ProviderSpec } from './keyStore.js';

/** Persisted provider config (the on-disk shape). */
export interface ProviderConfig {
  /** Currently active provider id (must be one of PROVIDERS). */
  activeProviderId: ProviderName;
  /** Per-provider default model. Always contains an entry for every provider. */
  modelByProvider: Record<ProviderName, string>;
  /**
   * Custom base URLs keyed by provider id (Task A3, v3-A).
   * Lets users point `openai-compatible` or `custom` at any self-hosted
   * endpoint (Ollama, LM Studio, vLLM, etc.) without code changes.
   * Empty string = use built-in default for that provider.
   */
  customEndpoints: Partial<Record<ProviderName, string>>;
}

const DEFAULTS: ProviderConfig = {
  activeProviderId: 'openai-compatible',
  modelByProvider: {
    'openai-compatible': 'grok-4',
    'minimax': 'MiniMax-M2.5',
    'glm': 'glm-4.6',
    'grok': 'grok-4',
    'custom': '',
  },
  customEndpoints: {},
};

export function getProviderConfigPath(): string {
  return process.env.ANATHEMA_PROVIDER_CONFIG_FILE
    ?? path.join(os.homedir(), '.tmp', 'anathema-coder', 'provider.json');
}

/** Return the resolved ProviderConfig (env override > on-disk > defaults). */
export function getProviderConfig(): ProviderConfig {
  // Env override for active provider (used by tests + CI).
  const envActive = process.env.ANATHEMA_ACTIVE_PROVIDER;
  const envModel = process.env.OPENAI_MODEL;
  const file = getProviderConfigPath();
  let stored: ProviderConfig | null = null;
  if (existsSync(file)) {
    try {
      const raw = readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<ProviderConfig>;
      if (parsed && typeof parsed === 'object' && typeof parsed.activeProviderId === 'string'
        && parsed.modelByProvider && typeof parsed.modelByProvider === 'object') {
        stored = {
          activeProviderId: parsed.activeProviderId as ProviderName,
          modelByProvider: { ...DEFAULTS.modelByProvider, ...parsed.modelByProvider },
          customEndpoints: mergeCustomEndpoints(parsed.customEndpoints),
        };
      }
    } catch {
      // Corrupt file — fall through to defaults.
    }
  }
  const base: ProviderConfig = stored ?? {
    ...DEFAULTS,
    modelByProvider: { ...DEFAULTS.modelByProvider },
    customEndpoints: { ...DEFAULTS.customEndpoints },
  };
  // Apply env overrides last so they always win.
  if (envActive && PROVIDERS.some((p) => p.id === envActive)) {
    base.activeProviderId = envActive as ProviderName;
  }
  if (envModel && envModel.trim().length > 0) {
    base.modelByProvider[base.activeProviderId] = envModel;
  }
  return base;
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

/** Async variant of getProviderConfig (used by tests + CLI startup). */
export async function loadProviderConfig(): Promise<ProviderConfig> {
  const file = getProviderConfigPath();
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ProviderConfig>;
    if (parsed && typeof parsed === 'object' && typeof parsed.activeProviderId === 'string'
      && parsed.modelByProvider && typeof parsed.modelByProvider === 'object') {
      return {
        activeProviderId: parsed.activeProviderId as ProviderName,
        modelByProvider: { ...DEFAULTS.modelByProvider, ...parsed.modelByProvider },
        customEndpoints: mergeCustomEndpoints(parsed.customEndpoints),
      };
    }
  } catch {
    // ENOENT or JSON parse failure — fall back.
  }
  return {
    ...DEFAULTS,
    modelByProvider: { ...DEFAULTS.modelByProvider },
    customEndpoints: { ...DEFAULTS.customEndpoints },
  };
}