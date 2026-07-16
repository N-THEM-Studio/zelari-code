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
  getProviderConfig,
  setActiveProviderId as persistActiveProvider,
  setModelForProvider as persistModelForProvider,
  getModelForProvider,
  setCustomEndpoint,
  clearCustomEndpoint,
  getCustomEndpoint,
} from '../providerConfig.js';
import {
  discoverModelsInBackground,
  discoverModelsForProvider,
  getCachedModels,
  isModelsCacheStale,
} from '../modelDiscovery.js';
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
  (id: string) => `[provider] unknown: ${id}. Available: openai-compatible, minimax, glm, grok, deepseek, custom`;

// ---------------------------------------------------------------------------
// Interactive picker plumbing (v0.7.10) — /provider and /model with no args
// open an arrow-key SelectList instead of printing a usage hint. The handler
// builds the items; the App renders the list and dispatches the selection
// back through the normal slash pipeline (`/provider <id>` / `/model <id>`).
// ---------------------------------------------------------------------------

export interface PickerItem {
  value: string;
  label: string;
  hint?: string;
  current?: boolean;
}

export interface PickerRequest {
  kind: 'provider' | 'model' | 'clarification';
  title: string;
  items: PickerItem[];
  /** Slash command the selected value is dispatched through (provider/model). */
  commandPrefix?: string;
  /**
   * v1.6.0: for kind 'clarification' — invoked with the chosen value when
   * the user picks an option from an agent-posed clarifying question. The
   * selected text flows into dispatchPrompt as the next user turn, and
   * rolling history ensures the model sees its own question. Absent for
   * provider/model kinds (those use commandPrefix).
   */
  onAnswer?: (value: string) => void;
  /**
   * v1.8.0: Esc / cancel on a clarification picker (council pause must
   * resolve so the run does not hang forever).
   */
  onCancel?: () => void;
}

export type OpenPicker = (req: PickerRequest) => void;

/** Provider ids that support /v1/models discovery. */
const DISCOVERABLE_PROVIDERS: readonly string[] = ['grok', 'glm', 'minimax', 'deepseek', 'openai-compatible'];

export function handleProviderList(ctx: ProviderSlashContext): void {
  const list = getActiveProviderSpec();
  const customEp = getCustomEndpoint(list.id);
  const epHint = customEp ? ` — custom endpoint: ${customEp}` : '';
  appendSystem(
    ctx.setMessages,
    `[provider] current: ${list.displayName} (model: ${ctx.activeModel})${epHint} — available: openai-compatible, minimax, glm, grok, deepseek, custom`,
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
    // v0.7.10 fix: push the full ProviderConfig into App state (this used to
    // pass a ProviderSpec, so the StatusBar model never refreshed on switch).
    ctx.setProviderConfig(getProviderConfig() as never);
    appendSystem(ctx.setMessages, `[provider] active: ${spec.displayName} (model: ${getModelForProvider(spec.id)})`);
  } catch (err) {
    appendSystem(ctx.setMessages, `[provider error] ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * /provider (no args) — open the interactive provider picker (v0.7.10).
 * Falls back to the text summary when the caller has no picker UI wired
 * (e.g. headless contexts).
 */
export function handleProviderPicker(ctx: ProviderSlashContext, openPicker?: OpenPicker): void {
  if (!openPicker) {
    handleProviderList(ctx);
    return;
  }
  const items: PickerItem[] = PROVIDERS.map((p) => {
    const customEp = getCustomEndpoint(p.id);
    const model = getModelForProvider(p.id);
    return {
      value: p.id,
      label: p.displayName,
      hint: customEp ?? (model || undefined),
      current: p.id === ctx.activeProviderSpec.id,
    };
  });
  openPicker({
    kind: 'provider',
    title: 'Switch provider',
    items,
    commandPrefix: '/provider',
  });
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
    if (DISCOVERABLE_PROVIDERS.includes(discoveryProvider)) {
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
      persistModelForProvider('grok', ctx.providerDefaults['grok'] ?? 'grok-4.5');
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
    // v0.7.10: refresh App state so the StatusBar shows the new model at once.
    ctx.setProviderConfig(getProviderConfig() as never);
    appendSystem(ctx.setMessages, `[model] set: ${id} → ${model}`);
  } catch (err) {
    appendSystem(ctx.setMessages, `[model error] ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Pure helper (exported for tests): build the /model picker items from the
 * discovered list, making sure the active model and the provider default are
 * always present even when discovery has nothing (or is missing them).
 */
export function buildModelPickerItems(
  models: readonly { id: string; ownedBy?: string }[],
  activeModel: string,
  defaultModel?: string,
): PickerItem[] {
  const items: PickerItem[] = models.map((m) => ({
    value: m.id,
    label: m.id,
    hint: m.ownedBy,
    current: m.id === activeModel,
  }));
  const seen = new Set(models.map((m) => m.id));
  if (defaultModel && !seen.has(defaultModel)) {
    items.unshift({
      value: defaultModel,
      label: defaultModel,
      hint: 'default',
      current: defaultModel === activeModel,
    });
  }
  if (activeModel && !seen.has(activeModel) && activeModel !== defaultModel) {
    items.unshift({ value: activeModel, label: activeModel, hint: 'current', current: true });
  }
  return items;
}

/**
 * /model (no args) — open the interactive model picker (v0.7.10).
 *
 * Discovery is wired in here: when the provider supports `/v1/models` and the
 * cache is missing or stale (>6h), the handler re-discovers before opening
 * the list, so the picker always shows fresh choices. A failed discovery
 * falls back to the cached list (or the defaults) with an inline note.
 */
export async function handleModelPicker(ctx: ProviderSlashContext, openPicker?: OpenPicker): Promise<void> {
  if (!openPicker) {
    handleModelsList(ctx);
    return;
  }
  const discId = ctx.activeProviderSpec.id as DiscoveryProviderId;
  let cached = getCachedModels(discId);
  if (DISCOVERABLE_PROVIDERS.includes(discId)
    && (!cached || cached.models.length === 0 || isModelsCacheStale(discId))) {
    appendSystem(ctx.setMessages, `[models] discovering models for ${ctx.activeProviderSpec.displayName}…`);
    try {
      cached = await discoverModelsForProvider(discId);
    } catch (err) {
      const fallback = cached && cached.models.length > 0 ? 'using cached list' : 'using defaults';
      appendSystem(
        ctx.setMessages,
        `[models] discovery failed: ${err instanceof Error ? err.message : String(err)} — ${fallback}`,
      );
    }
  }
  const items = buildModelPickerItems(
    cached?.models ?? [],
    ctx.activeModel,
    ctx.providerDefaults[discId],
  );
  if (items.length === 0) {
    appendSystem(
      ctx.setMessages,
      `[models] nothing to select for ${ctx.activeProviderSpec.displayName} — run /login ${discId} <key> first, then /discover`,
    );
    return;
  }
  openPicker({
    kind: 'model',
    title: `Select model — ${ctx.activeProviderSpec.displayName}`,
    items,
    commandPrefix: '/model',
  });
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