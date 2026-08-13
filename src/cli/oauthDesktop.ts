/**
 * oauthDesktop — non-interactive OAuth login / refresh / logout for Desktop + scripts.
 */
import {
  clearApiKey,
  forceRefreshOAuth,
  getOAuthToken,
  isOAuthProvider,
  maskKey,
  setOAuthToken,
  type ProviderName,
} from './keyStore.js';
import {
  getModelForProvider,
  setActiveProviderId,
  setModelForProvider,
} from './providerConfig.js';
import { discoverModelsForProvider, type ProviderId } from './modelDiscovery.js';
import { runGrokOAuthFlow } from './grokOAuth.js';
import { runChatgptOAuthFlow } from './chatgptOAuth.js';
import { completeAnthropicOAuth, startAnthropicOAuth } from './anthropicOAuth.js';

export interface OAuthActionResult {
  ok: boolean;
  provider?: string;
  phase?: 'need_code' | 'done';
  authorizeUrl?: string;
  message?: string;
  masked?: string;
  expiresAt?: number;
  hasRefreshToken?: boolean;
  error?: string;
}

const DEFAULT_MODELS: Partial<Record<ProviderName, string>> = {
  grok: 'grok-4.5',
  chatgpt: 'gpt-5.2-codex',
  anthropic: 'claude-sonnet-4-5',
};

export async function persistOAuthLogin(
  provider: ProviderName,
  token: {
    accessToken: string;
    expiresAt?: number;
    refreshToken?: string;
    accountId?: string;
    idToken?: string;
  },
): Promise<void> {
  setOAuthToken(provider, {
    apiKey: token.accessToken,
    ...(token.expiresAt !== undefined ? { expiresAt: token.expiresAt } : {}),
    ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
    ...(token.accountId ? { accountId: token.accountId } : {}),
    ...(token.idToken ? { idToken: token.idToken } : {}),
  });
  setActiveProviderId(provider);
  if (!getModelForProvider(provider)) {
    const fallback = DEFAULT_MODELS[provider];
    if (fallback) setModelForProvider(provider, fallback);
  }
  await discoverModelsForProvider(provider as ProviderId).catch(() => undefined);
}

export async function runLoginOAuth(opts: {
  provider: string;
  code?: string;
  noBrowser?: boolean;
}): Promise<OAuthActionResult> {
  const provider = opts.provider.trim();
  if (!isOAuthProvider(provider)) {
    return {
      ok: false,
      error: `provider '${provider}' has no OAuth login. Use: grok, chatgpt, anthropic`,
    };
  }
  try {
    if (provider === 'anthropic') {
      if (!opts.code) {
        const started = await startAnthropicOAuth({
          openBrowser: !opts.noBrowser,
        });
        return {
          ok: true,
          provider,
          phase: 'need_code',
          authorizeUrl: started.authorizeUrl,
          message:
            'Open the URL, sign in, then paste the code with --code (or /login anthropic <code>).',
        };
      }
      const token = await completeAnthropicOAuth({ pasteCode: opts.code });
      await persistOAuthLogin('anthropic', token);
      return {
        ok: true,
        provider,
        phase: 'done',
        masked: maskKey(token.accessToken),
        expiresAt: token.expiresAt,
        hasRefreshToken: Boolean(token.refreshToken),
        message: 'Anthropic OAuth login saved.',
      };
    }

    if (provider === 'chatgpt') {
      const token = await runChatgptOAuthFlow({
        openBrowserImpl: opts.noBrowser ? async () => undefined : undefined,
      });
      await persistOAuthLogin('chatgpt', token);
      return {
        ok: true,
        provider,
        phase: 'done',
        masked: maskKey(token.accessToken),
        expiresAt: token.expiresAt,
        hasRefreshToken: Boolean(token.refreshToken),
        message: 'ChatGPT OAuth login saved.',
      };
    }

    const token = await runGrokOAuthFlow({
      openBrowserImpl: opts.noBrowser ? async () => undefined : undefined,
    });
    await persistOAuthLogin('grok', token);
    return {
      ok: true,
      provider,
      phase: 'done',
      masked: maskKey(token.accessToken),
      expiresAt: token.expiresAt,
      hasRefreshToken: Boolean(token.refreshToken),
      message: 'Grok OAuth login saved.',
    };
  } catch (err) {
    return { ok: false, provider, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runRefreshOAuth(provider: string): Promise<OAuthActionResult> {
  if (!isOAuthProvider(provider)) {
    return { ok: false, error: `provider '${provider}' has no OAuth refresh` };
  }
  const stored = getOAuthToken(provider);
  if (!stored?.refreshToken) {
    return {
      ok: false,
      provider,
      error: `no refresh token for ${provider} — sign in again`,
    };
  }
  try {
    const next = await forceRefreshOAuth(provider);
    if (!next) return { ok: false, provider, error: 'refresh returned empty' };
    await discoverModelsForProvider(provider as ProviderId).catch(() => undefined);
    return {
      ok: true,
      provider,
      phase: 'done',
      masked: maskKey(next.apiKey),
      expiresAt: next.expiresAt,
      hasRefreshToken: Boolean(next.refreshToken),
      message: `Refreshed ${provider} OAuth token.`,
    };
  } catch (err) {
    return { ok: false, provider, error: err instanceof Error ? err.message : String(err) };
  }
}

export function runLogoutOAuth(provider: string): OAuthActionResult {
  if (!isOAuthProvider(provider)) {
    return { ok: false, error: `provider '${provider}' has no OAuth logout` };
  }
  clearApiKey(provider);
  return { ok: true, provider, message: `Cleared ${provider} credentials.` };
}
