/**
 * chatgptOAuth — ChatGPT subscription login (Codex public OAuth client).
 *
 * Device flow (preferred, matches official Codex CLI — NOT RFC 8628):
 *   POST JSON /api/accounts/deviceauth/usercode { client_id }
 *     → device_auth_id + user_code + interval
 *   User opens https://auth.openai.com/codex/device and enters user_code
 *   poll JSON /api/accounts/deviceauth/token { device_auth_id, user_code }
 *     → authorization_code + server-issued PKCE (code_verifier)
 *   POST form /oauth/token (authorization_code) → access + refresh
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
/** Codex constructs this; the usercode response does not include verification_uri. */
export const CHATGPT_DEVICE_VERIFY_URL = 'https://auth.openai.com/codex/device';
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

/** First-leg device session so Desktop can show the user_code before polling. */
export interface ChatgptDeviceSession extends ChatgptDeviceInfo {
  deviceAuthId: string;
  interval: number;
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

function errorSnippet(body: Record<string, unknown>): string {
  const err = body.error;
  if (typeof err === 'string' && err.trim()) return err.trim().slice(0, 160);
  if (err && typeof err === 'object') {
    const msg = (err as Record<string, unknown>).message;
    if (typeof msg === 'string' && msg.trim()) return msg.trim().slice(0, 160);
  }
  const msg = body.message;
  if (typeof msg === 'string' && msg.trim()) return msg.trim().slice(0, 160);
  return '';
}

function formatHttpError(prefix: string, status: number, body: Record<string, unknown>): string {
  const detail = errorSnippet(body);
  return detail ? `${prefix} HTTP ${status}: ${detail}` : `${prefix} HTTP ${status}`;
}

async function readJsonBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    /* empty */
  }
  return {};
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
  return { status: response.status, body: await readJsonBody(response) };
}

/** Codex device-auth endpoints expect JSON, not RFC 8628 form bodies. */
async function postJson(
  url: string,
  data: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(data),
    });
  } catch (err) {
    throw new ChatgptOAuthError(
      `ChatGPT OAuth network error: ${err instanceof Error ? err.message : String(err)}`,
      'network_error',
    );
  }
  return { status: response.status, body: await readJsonBody(response) };
}

function parsePollInterval(raw: unknown, fallback = 5): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string') {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
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
    throw new ChatgptOAuthError(formatHttpError('ChatGPT token refresh', status, body), code);
  }
  return parseTokenPayload(body, options.refreshToken);
}

export async function startChatgptDeviceAuth(options: {
  clientId?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<ChatgptDeviceSession> {
  const clientId =
    options.clientId || process.env.CHATGPT_OAUTH_CLIENT_ID || DEFAULT_CHATGPT_CLIENT_ID;
  const fetchImpl = options.fetchImpl ?? fetch;

  // Official Codex: JSON { client_id } only. Extra RFC 8628 / PKCE fields → HTTP 400.
  const start = await postJson(CHATGPT_DEVICE_CODE_URL, { client_id: clientId }, fetchImpl);
  if (start.status >= 400) {
    throw new ChatgptOAuthError(
      formatHttpError('ChatGPT device-code', start.status, start.body),
      `device_http_${start.status}`,
    );
  }

  const deviceAuthId =
    (typeof start.body.device_auth_id === 'string' && start.body.device_auth_id) ||
    (typeof start.body.device_code === 'string' && start.body.device_code) ||
    '';
  const userCode =
    (typeof start.body.user_code === 'string' && start.body.user_code) ||
    (typeof start.body.usercode === 'string' && start.body.usercode) ||
    '';
  const verificationUri =
    (typeof start.body.verification_uri === 'string' && start.body.verification_uri) ||
    (typeof start.body.verification_url === 'string' && start.body.verification_url) ||
    `${CHATGPT_DEVICE_VERIFY_URL}?user_code=${encodeURIComponent(userCode)}`;
  if (!deviceAuthId || !userCode) {
    throw new ChatgptOAuthError('Device-code response missing fields', 'no_device_code');
  }

  return {
    deviceAuthId,
    userCode,
    verificationUri,
    interval: parsePollInterval(start.body.interval, 5),
    ...(typeof start.body.verification_uri_complete === 'string'
      ? { verificationUriComplete: start.body.verification_uri_complete }
      : {}),
  };
}

export async function pollChatgptDeviceAuth(options: {
  deviceAuthId: string;
  userCode: string;
  clientId?: string;
  interval?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}): Promise<ChatgptOAuthResult> {
  const clientId =
    options.clientId || process.env.CHATGPT_OAUTH_CLIENT_ID || DEFAULT_CHATGPT_CLIENT_ID;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleepImpl ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = options.timeoutMs ?? 300_000;
  const deadline = Date.now() + timeoutMs;
  let interval = options.interval ?? 5;
  let authorizationCode: string | undefined;
  let codeVerifier: string | undefined;

  while (Date.now() < deadline) {
    const poll = await postJson(
      CHATGPT_DEVICE_TOKEN_URL,
      { device_auth_id: options.deviceAuthId, user_code: options.userCode },
      fetchImpl,
    );
    const authCode = poll.body.authorization_code;
    if (typeof authCode === 'string' && authCode.length > 0) {
      authorizationCode = authCode;
      if (typeof poll.body.code_verifier === 'string' && poll.body.code_verifier) {
        codeVerifier = poll.body.code_verifier;
      }
      break;
    }
    // Codex treats 403/404 as "not authorized yet".
    if (poll.status === 403 || poll.status === 404) {
      await sleep(interval * 1000);
      continue;
    }
    const err = typeof poll.body.error === 'string' ? poll.body.error : '';
    if (err === 'slow_down') interval += 5;
    else if (err && err !== 'authorization_pending') {
      throw new ChatgptOAuthError(`Device authorization failed: ${err}`, err);
    } else if (poll.status >= 400) {
      throw new ChatgptOAuthError(
        formatHttpError('ChatGPT device poll', poll.status, poll.body),
        `poll_http_${poll.status}`,
      );
    }
    await sleep(interval * 1000);
  }
  if (!authorizationCode) {
    throw new ChatgptOAuthError('Timed out waiting for ChatGPT device authorization', 'timeout');
  }
  if (!codeVerifier) {
    throw new ChatgptOAuthError(
      'Device token response missing code_verifier (server-issued PKCE)',
      'no_code_verifier',
    );
  }

  const token = await postForm(
    CHATGPT_TOKEN_URL,
    {
      grant_type: 'authorization_code',
      code: authorizationCode,
      redirect_uri: CHATGPT_DEVICE_REDIRECT_URI,
      client_id: clientId,
      code_verifier: codeVerifier,
    },
    fetchImpl,
  );
  if (token.status >= 400) {
    throw new ChatgptOAuthError(
      formatHttpError('ChatGPT token exchange', token.status, token.body),
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
      formatHttpError('ChatGPT token exchange', token.status, token.body),
      `token_http_${token.status}`,
    );
  }
  return parseTokenPayload(token.body);
}

export async function runChatgptDeviceFlow(options: {
  clientId?: string;
  onUserCode?: (info: ChatgptDeviceInfo) => void | Promise<void>;
  openBrowserImpl?: (url: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  timeoutMs?: number;
} = {}): Promise<ChatgptOAuthResult> {
  const session = await startChatgptDeviceAuth({
    clientId: options.clientId,
    fetchImpl: options.fetchImpl,
  });
  const info: ChatgptDeviceInfo = {
    userCode: session.userCode,
    verificationUri: session.verificationUri,
    ...(session.verificationUriComplete
      ? { verificationUriComplete: session.verificationUriComplete }
      : {}),
  };
  if (options.onUserCode) {
    await options.onUserCode(info);
  } else {
    // Desktop / --login-oauth has no TUI callback: print the Codex device page + code.
    // stderr: Desktop --login-oauth parses stdout as JSON.
    process.stderr.write(
      `[chatgpt oauth] Open ${info.verificationUri} and enter:\n  ${info.userCode}\n`,
    );
  }
  try {
    await (options.openBrowserImpl ?? openBrowser)(
      info.verificationUriComplete ?? info.verificationUri,
    );
  } catch {
    /* user can open the URL manually */
  }
  return pollChatgptDeviceAuth({
    deviceAuthId: session.deviceAuthId,
    userCode: session.userCode,
    clientId: options.clientId,
    interval: session.interval,
    fetchImpl: options.fetchImpl,
    sleepImpl: options.sleepImpl,
    timeoutMs: options.timeoutMs,
  });
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
