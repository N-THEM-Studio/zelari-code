import {
  getProviderSpec,
  setApiKey,
  setOAuthToken,
  maskKey,
  resolveApiKeyWithMeta,
  getOAuthToken,
  PROVIDERS,
} from '../keyStore.js';
import { getRefreshImpl } from '../refreshRegistry.js';
import { validateApiKey } from '../keyValidator.js';
import {
  getActiveProvider as getActiveProviderSpec,
  setActiveProviderId as persistActiveProvider,
  setModelForProvider as persistModelForProvider,
  getModelForProvider,
  setCustomEndpoint,
  clearCustomEndpoint,
  getCustomEndpoint,
} from '../providerConfig.js';
import { discoverModelsInBackground, discoverModelsForProvider, getCachedModels } from '../modelDiscovery.js';
import { appendSystem } from '../hooks/messageHelpers.js';
import { formatDuration } from '../utils/duration.js';
import type { ChatMessage } from '../components/ChatStream.js';
import type { ProviderId as DiscoveryProviderId } from '../modelDiscovery.js';

/**
 * Slash command handlers — provider switching, login, model selection,
 * model discovery. Extracted from app.tsx (Task v0.4.2 audit split).
 */
export interface ProviderSlashContext {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setInput: (v: string) => void;
  setProviderConfig: (cfg: ReturnType<typeof getProviderSpec> extends never ? never : unknown) => void;
  setBusy: (v: boolean) => void;
  activeProviderSpec: ReturnType<typeof getActiveProviderSpec>;
  activeModel: string;
  providerDefaults: Record<string, string>;
}

const UNKNOWN_PROVIDER_MSG =
  (id: string) => `[provider] unknown: ${id}. Available: openai-compatible, minimax, glm, grok, custom`;

export function handleProviderList(ctx: ProviderSlashContext): void {
  const list = getActiveProviderSpec();
  const customEp = getCustomEndpoint(list.id);
  const epHint = customEp ? ` — custom endpoint: ${customEp}` : '';
  appendSystem(
    ctx.setMessages,
    `[provider] current: ${list.displayName} (model: ${ctx.activeModel})${epHint} — available: openai-compatible, minimax, glm, grok, custom`,
  );
}

export function handleProviderSet(ctx: ProviderSlashContext, providerId: string): void {
  const spec = getProviderSpec(providerId);
  if (!spec) {
    appendSystem(ctx.setMessages, UNKNOWN_PROVIDER_MSG(providerId));
    return;
  }
  try {
    persistActiveProvider(spec.id);
    ctx.setProviderConfig(getProviderSpec(spec.id) as never); // refresh from getProviderConfig()
    appendSystem(ctx.setMessages, `[provider] active: ${spec.displayName} (model: ${getModelForProvider(spec.id)})`);
  } catch (err) {
    appendSystem(ctx.setMessages, `[provider error] ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function handleProviderCustom(
  ctx: ProviderSlashContext,
  opts: { endpoint?: string; clear?: boolean; message?: string },
): void {
  const id = ctx.activeProviderSpec.id;
  try {
    if (opts.clear) {
      clearCustomEndpoint(id);
      appendSystem(ctx.setMessages, `[provider] cleared custom endpoint for ${id} — falling back to default`);
    } else if (opts.endpoint) {
      setCustomEndpoint(id, opts.endpoint);
      appendSystem(ctx.setMessages, `[provider] custom endpoint for ${id} set to ${opts.endpoint}`);
    } else if (opts.message) {
      appendSystem(ctx.setMessages, `[provider] ${opts.message}`);
    }
  } catch (err) {
    appendSystem(ctx.setMessages, `[provider error] ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function handleProviderRefresh(ctx: ProviderSlashContext, providerId: string): Promise<void> {
  const spec = getProviderSpec(providerId);
  if (!spec) {
    appendSystem(ctx.setMessages, UNKNOWN_PROVIDER_MSG(providerId));
    return;
  }
  try {
    const refreshed = await resolveApiKeyWithMeta(spec.id);
    if (!refreshed) {
      appendSystem(ctx.setMessages, `[provider refresh] ${spec.id}: no key configured (use /login ${spec.id} <key>)`);
      return;
    }
    const expires = refreshed.expiresAt
      ? ` — expires in ${formatDuration(refreshed.expiresAt - Date.now())}`
      : '';
    const impl = getRefreshImpl(spec.id);
    const implNote = impl ? '' : ' (no refresh impl registered — stale token returned)';
    appendSystem(
      ctx.setMessages,
      `[provider refresh] ${spec.id}: ok — key ${maskKey(refreshed.apiKey)}${expires}${implNote}`,
    );
  } catch (err) {
    appendSystem(ctx.setMessages, `[provider refresh error] ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function handleProviderStatus(ctx: ProviderSlashContext, providerId: string): Promise<void> {
  const spec = getProviderSpec(providerId);
  if (!spec) {
    appendSystem(ctx.setMessages, UNKNOWN_PROVIDER_MSG(providerId));
    return;
  }
  const envKey = process.env[spec.envVar];
  const stored = getOAuthToken(spec.id);
  const source = envKey && envKey.trim().length > 0
    ? `env (${spec.envVar})`
    : stored ? 'store' : 'missing';
  const expires = stored?.expiresAt ? formatDuration(stored.expiresAt - Date.now()) : '—';
  const hasRefresh = getRefreshImpl(spec.id) ? 'yes' : 'no';
  const hasRefreshToken = stored?.refreshToken ? 'yes' : 'no';
  const baseUrl = spec.baseUrl ?? '—';
  const validation = await validateApiKey(spec.id, envKey ?? stored?.apiKey ?? '').catch(() => null);
  const valLine = validation
    ? validation.skipped
      ? `validation: skipped (no baseUrl)`
      : `validation: ${validation.ok ? 'ok' : `fail (${validation.reason})`}${validation.durationMs ? ` ${validation.durationMs}ms` : ''}`
    : 'validation: error';
  appendSystem(
    ctx.setMessages,
    `[provider status] ${spec.id} (${spec.displayName})\n` +
      `  env var:    ${spec.envVar}\n` +
      `  source:     ${source}\n` +
      `  expires:    ${expires}\n` +
      `  refresh:    ${hasRefresh} (impl registered)\n` +
      `  refreshTkn: ${hasRefreshToken}\n` +
      `  baseUrl:    ${baseUrl}\n` +
      `  ${valLine}`,
  );
}

export async function handleLoginKey(
  ctx: ProviderSlashContext,
  providerId: string,
  key: string,
): Promise<void> {
  const spec = getProviderSpec(providerId);
  const displayName = spec?.displayName ?? providerId;
  try {
    setApiKey(providerId, key);
    persistActiveProvider(providerId as Parameters<typeof persistActiveProvider>[0]);
    const currentModel = getModelForProvider(providerId as Parameters<typeof getModelForProvider>[0]);
    if (!currentModel) {
      const fallbackModel = ctx.providerDefaults[providerId];
      if (fallbackModel) {
        persistModelForProvider(providerId as Parameters<typeof persistModelForProvider>[0], fallbackModel);
      }
    }
    appendSystem(
      ctx.setMessages,
      `[login] ${displayName} key stored (${maskKey(key)}). Active provider switched to ${displayName} — try a prompt now.`,
    );
    // Background model discovery (fire-and-forget)
    const discoveryProvider = providerId as DiscoveryProviderId;
    if (['grok', 'glm', 'minimax', 'openai-compatible'].includes(discoveryProvider)) {
      discoverModelsInBackground(discoveryProvider, {
        onError: (err) =>
          appendSystem(
            ctx.setMessages,
            `[models] discovery failed for ${discoveryProvider}: ${err.message} (using static defaults)`,
          ),
      });
    }
  } catch (err) {
    appendSystem(ctx.setMessages, `[login error] ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function handleLoginOAuthGrok(ctx: ProviderSlashContext): Promise<void> {
  const { runGrokOAuthFlow } = await import('../grokOAuth.js');
  appendSystem(ctx.setMessages, '[login oauth] requesting device code from xAI...');
  ctx.setBusy(true);
  try {
    const resultOAuth = await runGrokOAuthFlow({
      onUserCode: (info) =>
        appendSystem(
          ctx.setMessages,
          `[login oauth] Open ${info.verificationUri} in your browser and enter the code:\n` +
            `  ${info.userCode}\n` +
            `(Opening your browser automatically...)`,
        ),
    });
    setOAuthToken('grok', {
      apiKey: resultOAuth.accessToken,
      ...(resultOAuth.expiresAt !== undefined ? { expiresAt: resultOAuth.expiresAt } : {}),
      ...(resultOAuth.refreshToken ? { refreshToken: resultOAuth.refreshToken } : {}),
    });
    persistActiveProvider('grok');
    if (!getModelForProvider('grok')) {
      persistModelForProvider('grok', ctx.providerDefaults['grok'] ?? 'grok-4');
    }
    const expiresHint = resultOAuth.expiresAt ? `, expires ${new Date(resultOAuth.expiresAt).toISOString()}` : '';
    const refreshHint = resultOAuth.refreshToken ? ', refresh token saved' : '';
    appendSystem(
      ctx.setMessages,
      `[login oauth] ✓ Grok authenticated via SuperGrok (token ${maskKey(resultOAuth.accessToken)}${expiresHint}${refreshHint}). Active provider switched to grok — try a prompt now.`,
    );
    discoverModelsInBackground('grok', {
      onError: (err) =>
        appendSystem(
          ctx.setMessages,
          `[models] discovery failed for grok: ${err.message} (using static defaults)`,
        ),
    });
  } catch (err) {
    appendSystem(ctx.setMessages, `[login oauth error] ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    ctx.setBusy(false);
  }
}

export function handleModelShow(ctx: ProviderSlashContext): void {
  appendSystem(
    ctx.setMessages,
    `[model] current: ${ctx.activeProviderSpec.displayName} → ${ctx.activeModel}`,
  );
}

export function handleModelSet(ctx: ProviderSlashContext, model: string): void {
  const id = ctx.activeProviderSpec.id;
  try {
    persistModelForProvider(id, model);
    appendSystem(ctx.setMessages, `[model] set: ${id} → ${model}`);
  } catch (err) {
    appendSystem(ctx.setMessages, `[model error] ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function handleModelsList(ctx: ProviderSlashContext): void {
  const discId = ctx.activeProviderSpec.id as DiscoveryProviderId;
  const cached = getCachedModels(discId);
  if (!cached || cached.models.length === 0) {
    appendSystem(
      ctx.setMessages,
      `[models] no cache for ${ctx.activeProviderSpec.displayName}. Run /models refresh or /login ${discId} <key> to discover.`,
    );
    return;
  }
  const ageMin = Math.round((Date.now() - cached.fetchedAt) / 60_000);
  const list = cached.models.map((m) => `  - ${m.id}${m.ownedBy ? ` (${m.ownedBy})` : ''}`).join('\n');
  appendSystem(
    ctx.setMessages,
    `[models] ${ctx.activeProviderSpec.displayName} — ${cached.models.length} models (fetched ${ageMin}m ago from ${cached.baseUrl}):\n${list}`,
  );
}

export function handleModelsRefresh(ctx: ProviderSlashContext): void {
  const discId = ctx.activeProviderSpec.id as DiscoveryProviderId;
  appendSystem(ctx.setMessages, `[models] refreshing model list for ${ctx.activeProviderSpec.displayName}...`);
  // Fire-and-forget background refresh; result surfaces inline.
  (async () => {
    try {
      const entry = await discoverModelsForProvider(discId);
      appendSystem(
        ctx.setMessages,
        `[models] ✓ ${entry.models.length} models discovered for ${ctx.activeProviderSpec.displayName}. Use /model <name> to switch.`,
      );
    } catch (err) {
      appendSystem(
        ctx.setMessages,
        `[models] ✗ discovery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();
}