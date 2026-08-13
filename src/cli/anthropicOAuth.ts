/**
 * anthropicOAuth — Claude Pro/Max subscription login (magic-link / paste-code).
 *
 * Claude Code-style PKCE against claude.ai. The redirect is Anthropic's hosted
 * callback, which shows a code (`CODE#STATE`) to paste back — no localhost.
 */
import { generatePkcePair } from './oauthPkce.js';
import { savePendingOAuth, takePendingOAuth } from './oauthSession.js';
import { openBrowser } from './grokOAuth.js';

export const DEFAULT_ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const ANTHROPIC_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const ANTHROPIC_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
export const ANTHROPIC_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
export const ANTHROPIC_SCOPE = 'org:create_api_key user:profile user:inference';

export interface AnthropicOAuthResult {
  accessToken: string;
  expiresAt?: number;
  refreshToken?: string;
}

export interface AnthropicStartResult {
  authorizeUrl: string;
  state: string;
}

export class AnthropicOAuthError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'AnthropicOAuthError';
  }
}

export function parseAnthropicPasteCode(raw: string): { code: string; state?: string } {
  const trimmed = raw.trim().replace(/^['"]|['"]$/g, '');
  const hash = trimmed.indexOf('#');
  if (hash === -1) return { code: trimmed };
  return { code: trimmed.slice(0, hash), state: trimmed.slice(hash + 1) || undefined };
}

export function buildAnthropicAuthorizeUrl(opts: {
  clientId: string;
  challenge: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    code: 'true',
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: ANTHROPIC_REDIRECT_URI,
    scope: ANTHROPIC_SCOPE,
    code_challenge: opts.challenge,
    code_challenge_method: 'S256',
    state: opts.state,
  });
  return `${ANTHROPIC_AUTHORIZE_URL}?${params.toString()}`;
}

function clientId(): string {
  const env = process.env.ANTHROPIC_OAUTH_CLIENT_ID;
  return env && env.trim().length > 0 ? env : DEFAULT_ANTHROPIC_CLIENT_ID;
}

export async function startAnthropicOAuth(options: {
  openBrowserImpl?: (url: string) => Promise<void>;
  openBrowser?: boolean;
} = {}): Promise<AnthropicStartResult> {
  const { verifier, challenge } = generatePkcePair();
  const state = verifier;
  savePendingOAuth({
    provider: 'anthropic',
    codeVerifier: verifier,
    state,
    createdAt: Date.now(),
  });
  const authorizeUrl = buildAnthropicAuthorizeUrl({
    clientId: clientId(),
    challenge,
    state,
  });
  if (options.openBrowser !== false) {
    try {
      await (options.openBrowserImpl ?? openBrowser)(authorizeUrl);
    } catch {
      /* caller shows the URL */
    }
  }
  return { authorizeUrl, state };
}

async function postJson(
  url: string,
  payload: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'anthropic',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new AnthropicOAuthError(
      `Anthropic OAuth network error: ${err instanceof Error ? err.message : String(err)}`,
      'network_error',
    );
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    /* empty */
  }
  return { status: response.status, body };
}

function parseToken(body: Record<string, unknown>, fallbackRefresh?: string): AnthropicOAuthResult {
  const accessToken = body.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new AnthropicOAuthError('Token response missing access_token', 'no_access_token');
  }
  const result: AnthropicOAuthResult = { accessToken };
  if (typeof body.expires_in === 'number' && Number.isFinite(body.expires_in)) {
    result.expiresAt = Date.now() + body.expires_in * 1000;
  }
  const refresh =
    (typeof body.refresh_token === 'string' && body.refresh_token) || fallbackRefresh;
  if (refresh) result.refreshToken = refresh;
  return result;
}

export async function completeAnthropicOAuth(options: {
  pasteCode: string;
  fetchImpl?: typeof fetch;
}): Promise<AnthropicOAuthResult> {
  const pending = takePendingOAuth('anthropic');
  if (!pending) {
    throw new AnthropicOAuthError(
      'No pending Anthropic login — run /login anthropic first',
      'no_pending',
    );
  }
  const parsed = parseAnthropicPasteCode(options.pasteCode);
  if (!parsed.code) {
    throw new AnthropicOAuthError('Empty authorization code', 'no_code');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const payload: Record<string, string> = {
    grant_type: 'authorization_code',
    code: parsed.code,
    code_verifier: pending.codeVerifier,
    client_id: clientId(),
    redirect_uri: ANTHROPIC_REDIRECT_URI,
    state: parsed.state ?? pending.state,
  };
  const { status, body } = await postJson(ANTHROPIC_TOKEN_URL, payload, fetchImpl);
  if (status >= 400) {
    const code = status === 400 || status === 401 ? 'invalid_grant' : `http_${status}`;
    throw new AnthropicOAuthError(
      `Anthropic token exchange HTTP ${status}: ${String(body.error ?? '').slice(0, 160)}`,
      code,
    );
  }
  return parseToken(body);
}

export async function refreshAnthropicToken(options: {
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<AnthropicOAuthResult> {
  if (!options.refreshToken.trim()) {
    throw new AnthropicOAuthError('Missing refreshToken', 'no_refresh_token');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const { status, body } = await postJson(
    ANTHROPIC_TOKEN_URL,
    {
      grant_type: 'refresh_token',
      refresh_token: options.refreshToken,
      client_id: clientId(),
    },
    fetchImpl,
  );
  if (status >= 400) {
    const code = status === 400 || status === 401 ? 'invalid_grant' : `http_${status}`;
    throw new AnthropicOAuthError(
      `Anthropic token refresh HTTP ${status}: ${String(body.error ?? '').slice(0, 160)}`,
      code,
    );
  }
  return parseToken(body, options.refreshToken);
}
