/**
 * grokOAuth — complete OAuth flow for xAI Grok / SuperGrok provider.
 *
 * Implements PKCE OAuth2 (RFC 7636) flow with OpenID Connect discovery,
 * matching the pattern used by the reference `supergrok-oauth` client
 * (https://github.com/toptoppy/supergrok-oauth).
 *
 * 1. Fetch OpenID Connect discovery document from `{issuer}/.well-known/openid-configuration`
 * 2. Generate PKCE verifier + S256 challenge
 * 3. Build authorization URL with state, scope, code_challenge
 * 4. Start local OAuth callback server (port 56121, path /callback)
 * 5. Open the user's browser to the authorization URL
 * 6. Wait for the redirect callback to deliver the authorization code
 * 7. Verify state to prevent CSRF
 * 8. Exchange code for access token (with code_verifier) at the token endpoint
 * 9. Return { accessToken, expiresAt, refreshToken }
 *
 * The browser launcher is INJECTED so tests can verify URL construction
 * without spawning a real browser. The fetch implementation is also injected
 * so tests can mock the token exchange.
 *
 * Default config (override via env GROK_OAUTH_CLIENT_ID):
 *   - Issuer: https://auth.x.ai
 *   - Client ID: b1a00492-073a-47ea-816f-4c329264a828 (xAI public OAuth client)
 *   - Scope: openid profile email offline_access grok-cli:access api:access
 *   - Redirect: http://127.0.0.1:56121/callback
 *
 * @see docs/plans/2026-06-29-anathema-coder-v2.md (Task 16.2)
 */

import { startOAuthCallbackServer, type OAuthCallbackServerHandle } from './oauthCallbackServer.js';
import nodeCrypto from 'node:crypto';

const { getRandomValues, createHash } = nodeCrypto;

export interface GrokOAuthOptions {
  /** OAuth client id (from env GROK_OAUTH_CLIENT_ID or default xAI public client). */
  clientId?: string;
  /** OAuth scopes. Default: xAI full SuperGrok scope. */
  scopes?: readonly string[];
  /** Callback port (default: 56121). Must match xAI registered redirect URI. */
  callbackPort?: number;
  /** Callback path (default: /callback). Must match xAI registered redirect URI. */
  callbackPath?: string;
  /** OAuth issuer (default: 'https://auth.x.ai'). Discovery URL is `${issuer}/.well-known/openid-configuration`. */
  issuer?: string;
  /** Override discovery URL (skips the .well-known fetch). */
  discoveryUrl?: string;
  /** Time to wait for browser callback (default: 120_000 ms). */
  callbackTimeoutMs?: number;
  /** Browser opener — opens the URL in the user's default browser. */
  onBrowserOpen?: (url: string) => void | Promise<void>;
  /** Fetch implementation for discovery + token exchange (default: global fetch). */
  fetchImpl?: typeof fetch;
}

export interface GrokOAuthResult {
  /** Access token to use as Bearer for xAI API calls. */
  accessToken: string;
  /** Token expiration epoch ms (if provider returned expires_in). */
  expiresAt?: number;
  /** Refresh token (if provider returned one). */
  refreshToken?: string;
  /** Refresh token expiration epoch ms (if provider returned refresh_token_expires_in). */
  refreshExpiresAt?: number;
}

export class GrokOAuthError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'GrokOAuthError';
  }
}

/**
 * Default xAI OAuth client ID — public client registered for SuperGrok OAuth
 * (same as used by the reference supergrok-oauth Python client).
 */
export const DEFAULT_GROK_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';

/** Default OAuth issuer for xAI authentication server. */
export const DEFAULT_GROK_OAUTH_ISSUER = 'https://auth.x.ai';

/** Default OAuth scopes for full SuperGrok access (matches supergrok-oauth config). */
export const DEFAULT_GROK_OAUTH_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'grok-cli:access',
  'api:access',
] as const;

/** Default redirect port (matches supergrok-oauth config). */
export const DEFAULT_GROK_OAUTH_REDIRECT_PORT = 56121;

/** Default redirect path (matches supergrok-oauth config). */
export const DEFAULT_GROK_OAUTH_REDIRECT_PATH = '/callback';

/** Fetch the OpenID Connect discovery document. */
export async function fetchGrokDiscovery(options: {
  issuer?: string;
  discoveryUrl?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<{ authorizationEndpoint: string; tokenEndpoint: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const discoveryUrl = options.discoveryUrl ?? `${options.issuer ?? DEFAULT_GROK_OAUTH_ISSUER}/.well-known/openid-configuration`;
  let response: Response;
  try {
    response = await fetchImpl(discoveryUrl, { method: 'GET', headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new GrokOAuthError(`OAuth discovery network error: ${err instanceof Error ? err.message : String(err)}`, 'discovery_network_error');
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new GrokOAuthError(
      `OAuth discovery HTTP ${response.status}: ${text.slice(0, 200)}`,
      `discovery_http_${response.status}`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new GrokOAuthError(`OAuth discovery returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!body || typeof body !== 'object') {
    throw new GrokOAuthError('OAuth discovery returned non-object body');
  }
  const obj = body as Record<string, unknown>;
  if (typeof obj.authorization_endpoint !== 'string' || typeof obj.token_endpoint !== 'string') {
    throw new GrokOAuthError('OAuth discovery missing authorization_endpoint or token_endpoint');
  }
  return {
    authorizationEndpoint: obj.authorization_endpoint,
    tokenEndpoint: obj.token_endpoint,
  };
}

/**
 * Generate PKCE verifier (RFC 7636) and S256 challenge.
 * Returns base64url-encoded strings (no padding).
 */
export function generatePkce(): { verifier: string; challenge: string } {
  // 64 random bytes → base64url → strip padding → take first 128 chars
  const random = getRandomValues(new Uint8Array(64));
  const verifier = Buffer.from(random).toString('base64url').slice(0, 128);

  // SHA-256(verifier) → base64url (no padding)
  const hash = createHash('sha256').update(verifier).digest();
  const challenge = hash.toString('base64url').replace(/=+$/, '');

  return { verifier, challenge };
}

/** Build the xAI authorization URL with PKCE. */
export function buildGrokAuthorizeUrl(options: {
  clientId: string;
  redirectUri: string;
  scopes?: readonly string[];
  state?: string;
  codeChallenge: string;
  authorizeEndpoint: string;
}): string {
  const scopes = options.scopes ?? DEFAULT_GROK_OAUTH_SCOPES;
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    state: options.state ?? crypto.randomUUID(),
    code_challenge: options.codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${options.authorizeEndpoint}?${params.toString()}`;
}

/** Exchange the authorization code for an access token. */
export async function exchangeGrokCode(options: {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  tokenEndpoint: string;
  fetchImpl?: typeof fetch;
}): Promise<GrokOAuthResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(options.tokenEndpoint, {
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
        code_verifier: options.codeVerifier,
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
  // xAI SuperGrok OAuth also returns refresh_token_expires_in (refresh token TTL).
  // Capture it so callers can warn before the refresh token expires.
  if (typeof obj.refresh_token_expires_in === 'number' && Number.isFinite(obj.refresh_token_expires_in)) {
    result.refreshExpiresAt = Date.now() + obj.refresh_token_expires_in * 1000;
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
 * Steps:
 *  1. Fetch OpenID Connect discovery document
 *  2. Generate PKCE verifier + S256 challenge
 *  3. Build authorization URL
 *  4. Start local callback server
 *  5. Open browser
 *  6. Wait for callback
 *  7. Verify state to prevent CSRF
 *  8. Exchange code for token (with code_verifier)
 *
 * @throws GrokOAuthError on any failure (network, missing params, provider error).
 */
export async function runGrokOAuthFlow(options: GrokOAuthOptions): Promise<GrokOAuthResult> {
  const clientId = options.clientId || process.env.GROK_OAUTH_CLIENT_ID || DEFAULT_GROK_OAUTH_CLIENT_ID;
  if (!clientId || clientId.trim().length === 0) {
    throw new GrokOAuthError('Missing clientId', 'no_client_id');
  }

  const callbackPort = options.callbackPort ?? DEFAULT_GROK_OAUTH_REDIRECT_PORT;
  const callbackPath = options.callbackPath ?? DEFAULT_GROK_OAUTH_REDIRECT_PATH;
  const redirectUri = `http://127.0.0.1:${callbackPort}${callbackPath}`;

  // Step 1: fetch OpenID Connect discovery document.
  const discovery = await fetchGrokDiscovery({
    issuer: options.issuer,
    discoveryUrl: options.discoveryUrl,
    fetchImpl: options.fetchImpl,
  });

  // Step 2: generate PKCE verifier + S256 challenge.
  const { verifier: codeVerifier, challenge: codeChallenge } = generatePkce();
  const state = crypto.randomUUID();

  // Step 3: build authorize URL with PKCE.
  const authorizeUrl = buildGrokAuthorizeUrl({
    clientId,
    redirectUri,
    scopes: options.scopes,
    state,
    codeChallenge,
    authorizeEndpoint: discovery.authorizationEndpoint,
  });

  // Step 4: start callback server.
  let handle: OAuthCallbackServerHandle;
  try {
    handle = await startOAuthCallbackServer({
      port: callbackPort,
      timeoutMs: options.callbackTimeoutMs ?? 120_000,
      expectedPath: callbackPath,
    });
  } catch (err) {
    throw new GrokOAuthError(
      `Failed to start OAuth callback server on port ${callbackPort}: ${err instanceof Error ? err.message : String(err)}`,
      'callback_bind_failed',
    );
  }

  try {
    // Step 5: open browser (or call injected opener for tests).
    if (options.onBrowserOpen) {
      await options.onBrowserOpen(authorizeUrl);
    } else {
      // Production path: open in default browser.
      await openBrowser(authorizeUrl);
    }

    // Step 6: wait for callback.
    const callbackResult = await handle.waitForCode();

    // Step 7: verify state (CSRF protection).
    if (callbackResult.state !== state) {
      throw new GrokOAuthError(
        `OAuth state mismatch — possible CSRF. expected=${state} got=${callbackResult.state ?? '(none)'}`,
        'state_mismatch',
      );
    }

    if (callbackResult.error) {
      throw new GrokOAuthError(
        `OAuth provider returned error: ${callbackResult.error}${callbackResult.errorDescription ? ` — ${callbackResult.errorDescription}` : ''}`,
        callbackResult.error,
      );
    }

    if (!callbackResult.code) {
      throw new GrokOAuthError('OAuth callback did not include authorization code', 'no_code');
    }

    // Step 8: exchange code for token (with code_verifier).
    return await exchangeGrokCode({
      clientId,
      code: callbackResult.code,
      codeVerifier,
      redirectUri,
      tokenEndpoint: discovery.tokenEndpoint,
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