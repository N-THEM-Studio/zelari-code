/**
 * chatgptOAuth — ChatGPT subscription login (Codex public OAuth client).
 *
 * Magic-link / device flow (preferred, matches Grok UX):
 *   POST /api/accounts/deviceauth/usercode → user_code + verification_uri
 *   poll /api/accounts/deviceauth/token → authorization_code
 *   POST /oauth/token (authorization_code) → access + refresh
 *
 * Optional browser PKCE (localhost:1455) via CHATGPT_OAUTH_FLOW=browser.
 */
import { generatePkcePair, generateOAuthState, waitForLoopbackCallback } from './oauthPkce.js';
import { openBrowser } from './grokOAuth.js';

export const DEFAULT_CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CHATGPT_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
export const CHATGPT_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const CHATGPT_DEVICE_CODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
export const CHATGPT_DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
export const CHATGPT_DEVICE_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback';
export const CHATGPT_SCOPE = 'openid profile email offline_access';
export const CHATGPT_AUTH_CLAIMS = 'https://api.openai.com/auth';

export interface ChatgptOAuthResult {
  accessToken: string;
  expiresAt?: number;
  refreshToken?: string;
  accountId?: string;
  idToken?: string;
}

export interface ChatgptDeviceInfo {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
}

export class ChatgptOAuthError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ChatgptOAuthError';
  }
}

export function decodeJwtClaims(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length < 2) return {};
  try {
    const json = Buffer.from(parts[1]!, 'base64url').toString('utf-8');
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function extractChatgptAccountId(idToken?: string): string | undefined {
  if (!idToken) return undefined;
  const claims = decodeJwtClaims(idToken);
  const auth = claims[CHATGPT_AUTH_CLAIMS];
  if (auth && typeof auth === 'object') {
    const id = (auth as Record<string, unknown>).chatgpt_account_id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return undefined;
}

function parseTokenPayload(
  obj: Record<string, unknown>,
  fallbackRefresh?: string,
): ChatgptOAuthResult {
  const accessToken = obj.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new ChatgptOAuthError('Token response missing access_token', 'no_access_token');
  }
  const idToken = typeof obj.id_token === 'string' ? obj.id_token : undefined;
  const refresh =
    (typeof obj.refresh_token === 'string' && obj.refresh_token) || fallbackRefresh;
  const result: ChatgptOAuthResult = { accessToken };
  if (typeof obj.expires_in === 'number' && Number.isFinite(obj.expires_in)) {
    result.expiresAt = Date.now() + obj.expires_in * 1000;
  }
  if (refresh) result.refreshToken = refresh;
  if (idToken) {
    result.idToken = idToken;
    const accountId = extractChatgptAccountId(idToken);
    if (accountId) result.accountId = accountId;
  }
  return result;
}

async function postForm(
  url: string,
  data: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(data).toString(),
    });
  } catch (err) {
    throw new ChatgptOAuthError(
      `ChatGPT OAuth network error: ${err instanceof Error ? err.message : String(err)}`,
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

export async function refreshChatgptToken(options: {
  refreshToken: string;
  clientId?: string;
  fetchImpl?: typeof fetch;
}): Promise<ChatgptOAuthResult> {
  if (!options.refreshToken.trim()) {
    throw new ChatgptOAuthError('Missing refreshToken', 'no_refresh_token');
  }
  const clientId =
    options.clientId || process.env.CHATGPT_OAUTH_CLIENT_ID || DEFAULT_CHATGPT_CLIENT_ID;
  const fetchImpl = options.fetchImpl ?? fetch;
  const { status, body } = await postForm(
    CHATGPT_TOKEN_URL,
    {
      grant_type: 'refresh_token',
      refresh_token: options.refreshToken,
      client_id: clientId,
    },
    fetchImpl,
  );
  if (status >= 400) {
    const code = status === 400 || status === 401 ? 'invalid_grant' : `http_${status}`;
    throw new ChatgptOAuthError(
      `ChatGPT token refresh HTTP ${status}: ${String(body.error ?? '').slice(0, 160)}`,
      code,
    );
  }
  return parseTokenPayload(body, options.refreshToken);
}

export async function runChatgptDeviceFlow(options: {
  clientId?: string;
  onUserCode?: (info: ChatgptDeviceInfo) => void | Promise<void>;
  openBrowserImpl?: (url: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}): Promise<ChatgptOAuthResult> {
  const clientId =
    options.clientId || process.env.CHATGPT_OAUTH_CLIENT_ID || DEFAULT_CHATGPT_CLIENT_ID;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleepImpl ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const { verifier, challenge } = generatePkcePair();

  const start = await postForm(
    CHATGPT_DEVICE_CODE_URL,
    {
      client_id: clientId,
      scope: CHATGPT_SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    },
    fetchImpl,
  );
  if (start.status >= 400) {
    throw new ChatgptOAuthError(
      `ChatGPT device-code HTTP ${start.status}`,
      `device_http_${start.status}`,
    );
  }
  const deviceCode = start.body.device_code;
  const userCode = start.body.user_code;
  const verificationUri =
    (typeof start.body.verification_uri === 'string' && start.body.verification_uri) ||
    (typeof start.body.verification_uri_complete === 'string' &&
      start.body.verification_uri_complete);
  if (
    typeof deviceCode !== 'string' ||
    typeof userCode !== 'string' ||
    typeof verificationUri !== 'string'
  ) {
    throw new ChatgptOAuthError('Device-code response missing fields', 'no_device_code');
  }
  const info: ChatgptDeviceInfo = {
    userCode,
    verificationUri,
    ...(typeof start.body.verification_uri_complete === 'string'
      ? { verificationUriComplete: start.body.verification_uri_complete }
      : {}),
  };
  if (options.onUserCode) await options.onUserCode(info);
  try {
    await (options.openBrowserImpl ?? openBrowser)(
      info.verificationUriComplete ?? info.verificationUri,
    );
  } catch {
    /* user can open the URL manually */
  }

  const timeoutMs = options.timeoutMs ?? 300_000;
  const deadline = Date.now() + timeoutMs;
  let interval = 5;
  let authorizationCode: string | undefined;
  while (Date.now() < deadline) {
    const poll = await postForm(
      CHATGPT_DEVICE_TOKEN_URL,
      { client_id: clientId, device_code: deviceCode },
      fetchImpl,
    );
    const authCode = poll.body.authorization_code;
    if (typeof authCode === 'string' && authCode.length > 0) {
      authorizationCode = authCode;
      break;
    }
    const err = typeof poll.body.error === 'string' ? poll.body.error : '';
    if (err === 'slow_down') interval += 5;
    else if (err && err !== 'authorization_pending') {
      throw new ChatgptOAuthError(`Device authorization failed: ${err}`, err);
    }
    await sleep(interval * 1000);
  }
  if (!authorizationCode) {
    throw new ChatgptOAuthError('Timed out waiting for ChatGPT device authorization', 'timeout');
  }

  const token = await postForm(
    CHATGPT_TOKEN_URL,
    {
      grant_type: 'authorization_code',
      code: authorizationCode,
      redirect_uri: CHATGPT_DEVICE_REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    },
    fetchImpl,
  );
  if (token.status >= 400) {
    throw new ChatgptOAuthError(
      `ChatGPT token exchange HTTP ${token.status}`,
      `token_http_${token.status}`,
    );
  }
  return parseTokenPayload(token.body);
}

export async function runChatgptBrowserFlow(options: {
  clientId?: string;
  port?: number;
  fetchImpl?: typeof fetch;
  openBrowserImpl?: (url: string) => Promise<void>;
  timeoutMs?: number;
}): Promise<ChatgptOAuthResult> {
  const clientId =
    options.clientId || process.env.CHATGPT_OAUTH_CLIENT_ID || DEFAULT_CHATGPT_CLIENT_ID;
  const port = options.port ?? 1455;
  const redirectUri = `http://localhost:${port}/auth/callback`;
  const state = generateOAuthState();
  const { verifier, challenge } = generatePkcePair();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: CHATGPT_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  const authorizeUrl = `${CHATGPT_AUTHORIZE_URL}?${params.toString()}`;
  try {
    await (options.openBrowserImpl ?? openBrowser)(authorizeUrl);
  } catch {
    /* printed by caller */
  }
  const cb = await waitForLoopbackCallback({
    port,
    path: '/auth/callback',
    timeoutMs: options.timeoutMs ?? 300_000,
  });
  if (cb.error) {
    throw new ChatgptOAuthError(
      `ChatGPT OAuth error: ${cb.error} ${cb.errorDescription ?? ''}`,
      cb.error,
    );
  }
  if (cb.state !== state) throw new ChatgptOAuthError('OAuth state mismatch', 'state_mismatch');
  if (!cb.code) throw new ChatgptOAuthError('Callback missing code', 'no_code');

  const fetchImpl = options.fetchImpl ?? fetch;
  const token = await postForm(
    CHATGPT_TOKEN_URL,
    {
      grant_type: 'authorization_code',
      code: cb.code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    },
    fetchImpl,
  );
  if (token.status >= 400) {
    throw new ChatgptOAuthError(
      `ChatGPT token exchange HTTP ${token.status}`,
      `token_http_${token.status}`,
    );
  }
  return parseTokenPayload(token.body);
}

export async function runChatgptOAuthFlow(options: {
  onUserCode?: (info: ChatgptDeviceInfo) => void | Promise<void>;
  openBrowserImpl?: (url: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  timeoutMs?: number;
} = {}): Promise<ChatgptOAuthResult> {
  const flow = (process.env.CHATGPT_OAUTH_FLOW ?? 'device').toLowerCase();
  if (flow === 'browser') {
    return runChatgptBrowserFlow(options);
  }
  return runChatgptDeviceFlow(options);
}
