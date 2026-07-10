/**
 * desktopConfig — non-interactive config dump/set for Zelari Desktop
 * and scripts. Never prints API keys.
 *
 * Flags (handled in main.ts before TUI):
 *   --print-config
 *   --set-config [--provider] [--model] [--endpoint] [--endpoint-clear]
 *   --set-key --provider <id> --key <secret>
 *   --discover-models [--provider <id>]
 */

import {
  PROVIDERS,
  resolveApiKey,
  getKeyStorePath,
  setApiKey,
  maskKey,
  type ProviderName,
} from './keyStore.js';
import {
  getProviderConfig,
  getProviderConfigPath,
  setActiveProviderId,
  setModelForProvider,
  setCustomEndpoint,
  clearCustomEndpoint,
  getCustomEndpoint,
  type ProviderConfig,
} from './providerConfig.js';
import {
  getCachedModels,
  discoverModelsForProvider,
  type ProviderId as DiscoveryProviderId,
} from './modelDiscovery.js';
import { getCurrentVersion } from './updater.js';

export interface DesktopProviderInfo {
  id: string;
  displayName: string;
  hasKey: boolean;
  envVar: string;
  models: string[];
  defaultModel: string;
  /** Custom base URL override if set. */
  endpoint?: string | null;
  /** Effective base URL (custom or builtin). */
  baseUrl?: string | null;
}

export interface DesktopConfigSnapshot {
  activeProviderId: string;
  modelByProvider: Record<string, string>;
  providers: DesktopProviderInfo[];
  cliVersion: string;
  configPaths: {
    provider: string;
    keys: string;
  };
}

/** True when argv requests --print-config. */
export function wantsPrintConfig(argv: readonly string[]): boolean {
  return argv.includes('--print-config');
}

export function wantsSetKey(argv: readonly string[]): boolean {
  return argv.includes('--set-key');
}

export function wantsDiscoverModels(argv: readonly string[]): boolean {
  return argv.includes('--discover-models');
}

export interface SetConfigRequest {
  provider?: string;
  model?: string;
  endpoint?: string;
  endpointClear?: boolean;
}

export interface SetConfigParseResult {
  /** null when --set-config is not present */
  request: SetConfigRequest | null;
  error?: string;
}

/**
 * Parse --set-config [--provider id] [--model name] [--endpoint url] [--endpoint-clear].
 */
export function parseSetConfigFlags(argv: readonly string[]): SetConfigParseResult {
  if (!argv.includes('--set-config')) {
    return { request: null };
  }

  let provider: string | undefined;
  let model: string | undefined;
  let endpoint: string | undefined;
  let endpointClear = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--provider') {
      provider = argv[i + 1];
      i++;
    } else if (arg === '--model') {
      model = argv[i + 1];
      i++;
    } else if (arg === '--endpoint') {
      endpoint = argv[i + 1];
      i++;
    } else if (arg === '--endpoint-clear') {
      endpointClear = true;
    }
  }

  if (!provider && !model && !endpoint && !endpointClear) {
    return {
      request: null,
      error:
        '--set-config requires --provider, --model, --endpoint, and/or --endpoint-clear',
    };
  }

  if (provider !== undefined && provider.trim().length === 0) {
    return { request: null, error: '--provider cannot be empty' };
  }
  if (model !== undefined && model.trim().length === 0) {
    return { request: null, error: '--model cannot be empty' };
  }
  if (endpoint !== undefined && endpoint.trim().length === 0) {
    return { request: null, error: '--endpoint cannot be empty' };
  }
  if (endpoint && endpointClear) {
    return { request: null, error: '--endpoint and --endpoint-clear conflict' };
  }

  return {
    request: {
      provider: provider?.trim(),
      model: model?.trim(),
      endpoint: endpoint?.trim(),
      endpointClear: endpointClear || undefined,
    },
  };
}

export interface SetKeyRequest {
  provider: string;
  key: string;
}

export interface SetKeyParseResult {
  request: SetKeyRequest | null;
  error?: string;
}

export function parseSetKeyFlags(argv: readonly string[]): SetKeyParseResult {
  if (!argv.includes('--set-key')) {
    return { request: null };
  }

  let provider: string | undefined;
  let key: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--provider') {
      provider = argv[i + 1];
      i++;
    } else if (arg === '--key') {
      key = argv[i + 1];
      i++;
    }
  }

  if (!provider || provider.trim().length === 0) {
    return { request: null, error: '--set-key requires --provider <id>' };
  }
  if (!key || key.trim().length === 0) {
    return { request: null, error: '--set-key requires --key <secret>' };
  }

  return {
    request: {
      provider: provider.trim(),
      key: key.trim(),
    },
  };
}

export interface DiscoverModelsParseResult {
  /** null when flag absent */
  provider: string | null;
  error?: string;
  present: boolean;
}

export function parseDiscoverModelsFlags(
  argv: readonly string[],
): DiscoverModelsParseResult {
  if (!argv.includes('--discover-models')) {
    return { provider: null, present: false };
  }

  let provider: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--provider') {
      provider = argv[i + 1];
      i++;
    }
  }

  return {
    present: true,
    provider: provider?.trim() || null,
  };
}

/** Build config snapshot for desktop/settings (no secrets). */
export function buildDesktopConfigSnapshot(): DesktopConfigSnapshot {
  const config: ProviderConfig = getProviderConfig();
  const providers: DesktopProviderInfo[] = PROVIDERS.map((p) => {
    const cached = getCachedModels(p.id as never);
    const models = cached?.models.map((m) => m.id) ?? [];
    const defaultModel = config.modelByProvider[p.id] ?? '';
    if (defaultModel && !models.includes(defaultModel)) {
      models.unshift(defaultModel);
    }
    const custom = getCustomEndpoint(p.id as ProviderName);
    const builtin = p.baseUrl ?? null;
    return {
      id: p.id,
      displayName: p.displayName,
      hasKey: !!resolveApiKey(p.id),
      envVar: p.envVar,
      models,
      defaultModel,
      endpoint: custom ?? null,
      baseUrl: custom ?? builtin,
    };
  });

  return {
    activeProviderId: config.activeProviderId,
    modelByProvider: { ...config.modelByProvider },
    providers,
    cliVersion: getCurrentVersion(),
    configPaths: {
      provider: getProviderConfigPath(),
      keys: getKeyStorePath(),
    },
  };
}

/** Write one JSON object to stdout (pretty for humans, still single payload). */
export function printDesktopConfig(): void {
  const snap = buildDesktopConfigSnapshot();
  process.stdout.write(JSON.stringify(snap, null, 2) + '\n');
}

/**
 * Persist provider, model, and/or custom endpoint.
 */
export function applySetConfig(
  req: SetConfigRequest,
): { ok: true; message: string } | { ok: false; error: string } {
  try {
    const config = getProviderConfig();
    let targetProvider = (req.provider ?? config.activeProviderId) as ProviderName;

    if (req.provider) {
      const exists = PROVIDERS.some((p) => p.id === req.provider);
      if (!exists) {
        return {
          ok: false,
          error: `unknown provider '${req.provider}'. Available: ${PROVIDERS.map((p) => p.id).join(', ')}`,
        };
      }
      setActiveProviderId(req.provider as ProviderName);
      targetProvider = req.provider as ProviderName;
    }

    // Endpoint ops target explicit provider or active; for endpoint-only
    // without --provider, prefer openai-compatible when clearing/setting
    // and user is not targeting a specific provider... actually use targetProvider.
    if (req.endpointClear) {
      clearCustomEndpoint(targetProvider);
    }
    if (req.endpoint) {
      setCustomEndpoint(targetProvider, req.endpoint);
    }

    if (req.model) {
      setModelForProvider(targetProvider, req.model);
    }

    const after = getProviderConfig();
    const ep = getCustomEndpoint(after.activeProviderId as ProviderName);
    return {
      ok: true,
      message:
        `activeProvider=${after.activeProviderId} ` +
        `model=${after.modelByProvider[after.activeProviderId]}` +
        (ep ? ` endpoint=${ep}` : ''),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Store API key (never echoes the secret). */
export function applySetKey(
  req: SetKeyRequest,
): { ok: true; provider: string; masked: string } | { ok: false; error: string } {
  try {
    const exists = PROVIDERS.some((p) => p.id === req.provider);
    if (!exists) {
      return {
        ok: false,
        error: `unknown provider '${req.provider}'. Available: ${PROVIDERS.map((p) => p.id).join(', ')}`,
      };
    }
    setApiKey(req.provider, req.key);
    setActiveProviderId(req.provider as ProviderName);
    return {
      ok: true,
      provider: req.provider,
      masked: maskKey(req.key),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const DISCOVERABLE: DiscoveryProviderId[] = [
  'grok',
  'glm',
  'minimax',
  'deepseek',
  'openai-compatible',
];

/** Fetch and cache models; print JSON result. */
export async function runDiscoverModels(
  providerArg: string | null,
): Promise<{ ok: true; payload: object } | { ok: false; error: string }> {
  const config = getProviderConfig();
  const providerId = (providerArg ?? config.activeProviderId).trim();

  if (!DISCOVERABLE.includes(providerId as DiscoveryProviderId)) {
    // custom may still work via openai-compatible discovery if mapped — try openai-compatible path
    if (providerId === 'custom') {
      // Fall through using openai-compatible discovery with custom endpoint if set
    } else {
      return {
        ok: false,
        error: `provider '${providerId}' is not discoverable. Use: ${DISCOVERABLE.join(', ')}`,
      };
    }
  }

  const discoveryId = (
    providerId === 'custom' ? 'openai-compatible' : providerId
  ) as DiscoveryProviderId;

  try {
    const entry = await discoverModelsForProvider(discoveryId);
    return {
      ok: true,
      payload: {
        ok: true,
        provider: providerId,
        models: entry.models.map((m) => m.id),
        fetchedAt: entry.fetchedAt,
        baseUrl: entry.baseUrl,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
