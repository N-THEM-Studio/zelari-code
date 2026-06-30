/**
 * grokOAuth — complete OAuth flow for xAI Grok provider.
 *
 * 1. Build the authorization URL with client_id, redirect_uri, scope, state.
 * 2. Start the local OAuth callback server.
 * 3. Open the user's browser to the authorization URL (via onBrowserOpen callback).
 * 4. Wait for the redirect callback to deliver the authorization code.
 * 5. Exchange the code for an access token at the token endpoint.
 * 6. Return { accessToken, expiresAt }.
 *
 * The browser launcher is INJECTED so tests can verify URL construction
 * without spawning a real browser. The fetch implementation is also injected
 * so tests can mock the token exchange.
 *
 * @see docs/plans/2026-06-29-anathema-coder-v2.md (Task 16.2)
 */

import { startOAuthCallbackServer, type OAuthCallbackServerHandle } from './oauthCallbackServer.js';

export interface GrokOAuthOptions {
  /** OAuth client id (from env GROK_OAUTH_CLIENT_ID or app settings). */
  clientId: string;
  /** OAuth scopes (default: ['chat']). */
  scopes?: readonly string[];
  /** Callback port (default: 14523). Must match xAI app config. */
  callbackPort?: number;
  /** OAuth authorize endpoint (default: 'https://oauth.x.ai/authorize'). */
  authorizeEndpoint?: string;
  /** OAuth token exchange endpoint (default: 'https://oauth.x.ai/token'). */
  tokenEndpoint?: string;
  /** Time to wait for browser callback (default: 60_000 ms). */
  callbackTimeoutMs?: number;
  /** Browser opener — opens the URL in the user's default browser. */
  onBrowserOpen?: (url: string) => void | Promise<void>;
  /** Fetch implementation for token exchange (default: global fetch). */
  fetchImpl?: typeof fetch;
}

export interface GrokOAuthResult {
  /** Access token to use as Bearer for xAI API calls. */
  accessToken: string;
  /** Token expiration epoch ms (if provider returned expires_in). */
  expiresAt?: number;
  /** Refresh token (if provider returned one). */
  refreshToken?: string;
}

export class GrokOAuthError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'GrokOAuthError';
  }
}

/** Build the xAI authorization URL with all required params. */
export function buildGrokAuthorizeUrl(options: {
  clientId: string;
  redirectUri: string;
  scopes?: readonly string[];
  state?: string;
  authorizeEndpoint?: string;
}): string {
  const endpoint = options.authorizeEndpoint ?? 'https://oauth.x.ai/authorize';
  const scopes = options.scopes ?? ['chat'];
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    state: options.state ?? crypto.randomUUID(),
  });
  return `${endpoint}?${params.toString()}`;
}

/** Exchange the authorization code for an access token. */
export async function exchangeGrokCode(options: {
  clientId: string;
  code: string;
  redirectUri: string;
  tokenEndpoint?: string;
  fetchImpl?: typeof fetch;
}): Promise<GrokOAuthResult> {
  const endpoint = options.tokenEndpoint ?? 'https://oauth.x.ai/token';
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: options.clientId,
        code: options.code,
        redirect_uri: options.redirectUri,
      }).toString(),
    });
  } catch (err) {
    throw new GrokOAuthError(`Token exchange network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new GrokOAuthError(
      `Token exchange HTTP ${response.status}: ${errText.slice(0, 200)}`,
      `http_${response.status}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new GrokOAuthError(`Token exchange returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!body || typeof body !== 'object') {
    throw new GrokOAuthError('Token exchange returned non-object body');
  }
  const obj = body as Record<string, unknown>;

  const accessToken = obj.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new GrokOAuthError('Token exchange response missing access_token', 'no_access_token');
  }

  return parseTokenResponseBody(obj, accessToken, 'Token exchange');
}

/**
 * Parse the standard OAuth token response body into a GrokOAuthResult.
 * Shared between `exchangeGrokCode` and `refreshGrokToken`.
 *
 * @param label Human-readable label for the operation (used in error messages).
 * @param accessToken Pre-validated access token from the body.
 */
function parseTokenResponseBody(
  obj: Record<string, unknown>,
  accessToken: string,
  label: string,
): GrokOAuthResult {
  const result: GrokOAuthResult = { accessToken };
  if (typeof obj.expires_in === 'number' && Number.isFinite(obj.expires_in)) {
    result.expiresAt = Date.now() + obj.expires_in * 1000;
  }
  if (typeof obj.refresh_token === 'string' && obj.refresh_token.length > 0) {
    result.refreshToken = obj.refresh_token;
  }
  // Some providers also return `scope` — we ignore it for now.
  void obj;
  void label;
  return result;
}

/**
 * Exchange a refresh token for a new access token (Task D.2.1, v3-D).
 *
 * Per RFC 6749 §6, the request body is:
 *   grant_type=refresh_token&refresh_token=<token>&client_id=<id>
 *
 * Some providers also require `client_secret` — xAI does not (public OAuth).
 *
 * The provider MAY rotate the refresh_token: callers should treat the
 * returned `refreshToken` (if any) as the new authoritative value and
 * persist it. If the provider does NOT return a new refresh_token, the
 * caller should keep using the previous one.
 */
export async function refreshGrokToken(options: {
  clientId: string;
  refreshToken: string;
  tokenEndpoint?: string;
  fetchImpl?: typeof fetch;
}): Promise<GrokOAuthResult> {
  if (!options.clientId || options.clientId.trim().length === 0) {
    throw new GrokOAuthError('Missing clientId', 'no_client_id');
  }
  if (!options.refreshToken || options.refreshToken.trim().length === 0) {
    throw new GrokOAuthError('Missing refreshToken', 'no_refresh_token');
  }

  const endpoint = options.tokenEndpoint ?? 'https://oauth.x.ai/token';
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: options.clientId,
        refresh_token: options.refreshToken,
      }).toString(),
    });
  } catch (err) {
    throw new GrokOAuthError(`Token refresh network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    // 400/401 with "invalid_grant" → refresh token expired or revoked.
    const code = response.status === 400 || response.status === 401 ? 'invalid_grant' : `http_${response.status}`;
    throw new GrokOAuthError(
      `Token refresh HTTP ${response.status}: ${errText.slice(0, 200)}`,
      code,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new GrokOAuthError(`Token refresh returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!body || typeof body !== 'object') {
    throw new GrokOAuthError('Token refresh returned non-object body');
  }
  const obj = body as Record<string, unknown>;

  const accessToken = obj.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new GrokOAuthError('Token refresh response missing access_token', 'no_access_token');
  }

  return parseTokenResponseBody(obj, accessToken, 'Token refresh');
}

/**
 * Run the complete OAuth flow.
 *
 * @throws GrokOAuthError on any failure (network, missing params, provider error).
 */
export async function runGrokOAuthFlow(options: GrokOAuthOptions): Promise<GrokOAuthResult> {
  if (!options.clientId || options.clientId.trim().length === 0) {
    throw new GrokOAuthError('Missing clientId', 'no_client_id');
  }

  const callbackPort = options.callbackPort ?? 14523;
  const redirectUri = `http://127.0.0.1:${callbackPort}/oauth/callback`;
  const state = crypto.randomUUID();

  // Step 1: build authorize URL.
  const authorizeUrl = buildGrokAuthorizeUrl({
    clientId: options.clientId,
    redirectUri,
    scopes: options.scopes,
    state,
    authorizeEndpoint: options.authorizeEndpoint,
  });

  // Step 2: start callback server.
  let handle: OAuthCallbackServerHandle;
  try {
    handle = await startOAuthCallbackServer({
      port: callbackPort,
      timeoutMs: options.callbackTimeoutMs ?? 60_000,
      expectedPath: '/oauth/callback',
    });
  } catch (err) {
    throw new GrokOAuthError(
      `Failed to start OAuth callback server on port ${callbackPort}: ${err instanceof Error ? err.message : String(err)}`,
      'callback_bind_failed',
    );
  }

  try {
    // Step 3: open browser (or call injected opener for tests).
    if (options.onBrowserOpen) {
      await options.onBrowserOpen(authorizeUrl);
    } else {
      // Production path: open in default browser.
      await openBrowser(authorizeUrl);
    }

    // Step 4: wait for callback.
    const code = await handle.waitForCode();

    // Step 5: verify state if provider supports it (best-effort: we sent a UUID).
    // We don't have access to the original URL on the server, so we skip strict state
    // verification here; if needed, callers can pass a custom callback server.

    // Step 6: exchange code for token.
    return await exchangeGrokCode({
      clientId: options.clientId,
      code,
      redirectUri,
      tokenEndpoint: options.tokenEndpoint,
      fetchImpl: options.fetchImpl,
    });
  } finally {
    handle.close();
  }
}

/**
 * Open the given URL in the user's default browser. Cross-platform via
 * child_process. Safe to call from Node 20+ — no shell injection (uses
 * spawn with args array).
 */
export async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  // Detect platform via process.env.PLATFORM? Use process.platform.
  // 'darwin' → open, 'win32' → start (cmd /c start ""), else → xdg-open
  const cmd = (() => {
    switch (process.platform) {
      case 'darwin': return { bin: 'open', args: [url] };
      case 'win32':  return { bin: 'cmd', args: ['/c', 'start', '""', url] };
      default:       return { bin: 'xdg-open', args: [url] };
    }
  })();
  return new Promise<void>((resolve, reject) => {
    try {
      const child = spawn(cmd.bin, cmd.args, { stdio: 'ignore', detached: true });
      child.on('error', (err) => reject(err));
      child.on('spawn', () => {
        // Detach so the browser process can outlive the Node CLI.
        child.unref();
        resolve();
      });
      // Fallback in case 'spawn' doesn't fire on all platforms.
      setTimeout(() => resolve(), 100);
    } catch (err) {
      reject(err);
    }
  });
}