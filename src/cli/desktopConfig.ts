/**
 * desktopConfig — non-interactive config dump/set for Zelari Desktop
 * and scripts. Never prints API keys.
 *
 * Flags (handled in main.ts before TUI):
 *   --print-config
 *   --set-config [--provider <id>] [--model <name>]
 */

import {
  PROVIDERS,
  resolveApiKey,
  getKeyStorePath,
  type ProviderName,
} from './keyStore.js';
import {
  getProviderConfig,
  getProviderConfigPath,
  setActiveProviderId,
  setModelForProvider,
  type ProviderConfig,
} from './providerConfig.js';
import { getCachedModels } from './modelDiscovery.js';
import { getCurrentVersion } from './updater.js';

export interface DesktopProviderInfo {
  id: string;
  displayName: string;
  hasKey: boolean;
  envVar: string;
  models: string[];
  defaultModel: string;
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

export interface SetConfigRequest {
  provider?: string;
  model?: string;
}

export interface SetConfigParseResult {
  /** null when --set-config is not present */
  request: SetConfigRequest | null;
  error?: string;
}

/**
 * Parse --set-config [--provider id] [--model name].
 * Returns request:null when flag absent.
 */
export function parseSetConfigFlags(argv: readonly string[]): SetConfigParseResult {
  if (!argv.includes('--set-config')) {
    return { request: null };
  }

  let provider: string | undefined;
  let model: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--provider') {
      provider = argv[i + 1];
      i++;
    } else if (arg === '--model') {
      model = argv[i + 1];
      i++;
    }
  }

  if (!provider && !model) {
    return {
      request: null,
      error: '--set-config requires --provider <id> and/or --model <name>',
    };
  }

  if (provider !== undefined && provider.trim().length === 0) {
    return { request: null, error: '--provider cannot be empty' };
  }
  if (model !== undefined && model.trim().length === 0) {
    return { request: null, error: '--model cannot be empty' };
  }

  return {
    request: {
      provider: provider?.trim(),
      model: model?.trim(),
    },
  };
}

/** Build config snapshot for desktop/settings (no secrets). */
export function buildDesktopConfigSnapshot(): DesktopConfigSnapshot {
  const config: ProviderConfig = getProviderConfig();
  const providers: DesktopProviderInfo[] = PROVIDERS.map((p) => {
    const cached = getCachedModels(p.id as never);
    const models = cached?.models.map((m) => m.id) ?? [];
    const defaultModel = config.modelByProvider[p.id] ?? '';
    // Ensure active default is in the list for the UI select
    if (defaultModel && !models.includes(defaultModel)) {
      models.unshift(defaultModel);
    }
    return {
      id: p.id,
      displayName: p.displayName,
      hasKey: !!resolveApiKey(p.id),
      envVar: p.envVar,
      models,
      defaultModel,
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
 * Persist provider and/or model. Model is applied to the target provider
 * (explicit --provider, else current active).
 */
export function applySetConfig(req: SetConfigRequest): { ok: true; message: string } | { ok: false; error: string } {
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

    if (req.model) {
      setModelForProvider(targetProvider, req.model);
    }

    const after = getProviderConfig();
    return {
      ok: true,
      message: `activeProvider=${after.activeProviderId} model=${after.modelByProvider[after.activeProviderId]}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
