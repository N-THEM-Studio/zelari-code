/**
 * grokOAuth — Device Authorization Grant (RFC 8628) flow for xAI Grok / SuperGrok.
 *
 * xAI does NOT support the browser-redirect Authorization Code Grant for its
 * public OAuth client (`response_type=code` returns "Only response_type=code
 * is supported" against the device endpoint, and the redirect flow is not
 * registered). Instead xAI exposes the Device Authorization Grant — the same
 * "sign in on another device" pattern used by Netflix on TVs and GitHub CLI.
 *
 * Flow:
 *   1. POST /oauth2/device/code  →  { device_code, user_code, verification_uri, ... }
 *   2. Show the user: "Visit <verification_uri> and enter code <user_code>"
 *   3. Poll POST /oauth2/token with grant_type=device_code until:
 *        - access_token returned (success)
 *        - "expired"/"denied" error
 *        - timeout
 *   4. Return { accessToken, expiresAt, refreshToken }
 *
 * Endpoints (xAI auth server):
 *   - Device code:  https://auth.x.ai/oauth2/device/code
 *   - Token:        https://auth.x.ai/oauth2/token
 *
 * Default config (override via env GROK_OAUTH_CLIENT_ID):
 *   - Client ID: b1a00492-073a-47ea-816f-4c329264a828 (xAI public OAuth client)
 *   - Scope: openid profile email offline_access grok-cli:access api:access
 *
 * @see https://datatracker.ietf.org/doc/html/rfc8628
 * @see docs/plans/2026-06-29-anathema-coder-v2.md (Task 16.2)
 */

export interface GrokOAuthOptions {
  /** OAuth client id (from env GROK_OAUTH_CLIENT_ID or default xAI public client). */
  clientId?: string;
  /** OAuth scopes. Default: xAI full SuperGrok scope. */
  scopes?: readonly string[];
  /** Device code endpoint (default: 'https://auth.x.ai/oauth2/device/code'). */
  deviceCodeEndpoint?: string;
  /** Token endpoint (default: 'https://auth.x.ai/oauth2/token'). */
  tokenEndpoint?: string;
  /** Overall timeout waiting for user authorization (default: 300_000 ms = 5 min). */
  timeoutMs?: number;
  /**
   * Called once with the device-authorization response so the caller can
   * display the user_code + verification_uri to the user. Required in
   * production; tests inject a stub.
   */
  onUserCode?: (info: DeviceAuthorization) => void | Promise<void>;
  /** Sleep function injected for tests (default: setTimeout-based). */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Fetch implementation (default: global fetch). */
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

/** Response from the device-code request (RFC 8628 §3.1). */
export interface DeviceAuthorization {
  /** The device verification code (posted to the token endpoint while polling). */
  deviceCode: string;
  /** Short code the user enters in the browser. */
  userCode: string;
  /** URL the user must visit. */
  verificationUri: string;
  /** Full URL with the user_code pre-filled (verification_uri_complete), if provided. */
  verificationUriComplete?: string;
  /** Lifetime of the device_code in seconds. */
  expiresIn: number;
  /** Minimum seconds between poll requests. */
  interval: number;
}

export class GrokOAuthError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'GrokOAuthError';
  }
}

/**
 * Default xAI OAuth client ID — public client registered for SuperGrok OAuth
 * (same as used by the reference supergrok-oauth Python client + Grok-CLI).
 */
export const DEFAULT_GROK_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';

/** Default OAuth scopes for full SuperGrok access. */
export const DEFAULT_GROK_OAUTH_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'grok-cli:access',
  'api:access',
] as const;

/** Default device-code endpoint. */
export const DEFAULT_DEVICE_CODE_ENDPOINT = 'https://auth.x.ai/oauth2/device/code';

/** Default token endpoint (shared by device poll + refresh). */
export const DEFAULT_TOKEN_ENDPOINT = 'https://auth.x.ai/oauth2/token';

/** Device-code grant type URN (RFC 8628). */
export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** Default overall authorization timeout (5 minutes). */
export const DEFAULT_OAUTH_TIMEOUT_MS = 300_000;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Request a device authorization code (RFC 8628 §3.1).
 *
 * POSTs client_id + scope to the device-code endpoint and returns the
 * device_code, user_code, verification_uri, and polling interval.
 */
export async function requestDeviceCode(options: {
  clientId: string;
  scopes?: readonly string[];
  deviceCodeEndpoint?: string;
  fetchImpl?: typeof fetch;
}): Promise<DeviceAuthorization> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.deviceCodeEndpoint ?? DEFAULT_DEVICE_CODE_ENDPOINT;
  const scopes = options.scopes ?? DEFAULT_GROK_OAUTH_SCOPES;

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: options.clientId,
        scope: scopes.join(' '),
      }).toString(),
    });
  } catch (err) {
    throw new GrokOAuthError(
      `Device code request network error: ${err instanceof Error ? err.message : String(err)}`,
      'device_code_network_error',
    );
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new GrokOAuthError(
      `Device code request HTTP ${response.status}: ${errText.slice(0, 200)}`,
      `device_code_http_${response.status}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new GrokOAuthError(
      `Device code response invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!body || typeof body !== 'object') {
    throw new GrokOAuthError('Device code response is not an object');
  }
  const obj = body as Record<string, unknown>;

  const deviceCode = obj.device_code;
  const userCode = obj.user_code;
  const verificationUri = obj.verification_uri;

  if (typeof deviceCode !== 'string' || deviceCode.length === 0) {
    throw new GrokOAuthError('Device code response missing device_code', 'no_device_code');
  }
  if (typeof userCode !== 'string' || userCode.length === 0) {
    throw new GrokOAuthError('Device code response missing user_code', 'no_user_code');
  }
  if (typeof verificationUri !== 'string' || verificationUri.length === 0) {
    throw new GrokOAuthError('Device code response missing verification_uri', 'no_verification_uri');
  }

  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(typeof obj.verification_uri_complete === 'string' && obj.verification_uri_complete.length > 0
      ? { verificationUriComplete: obj.verification_uri_complete }
      : {}),
    expiresIn: typeof obj.expires_in === 'number' && Number.isFinite(obj.expires_in) ? obj.expires_in : 1800,
    interval: typeof obj.interval === 'number' && Number.isFinite(obj.interval) ? obj.interval : 5,
  };
}

/**
 * Parse the standard OAuth token response body into a GrokOAuthResult.
 * Shared between the device-code poll and `refreshGrokToken`.
 */
function parseTokenResponseBody(obj: Record<string, unknown>, accessToken: string): GrokOAuthResult {
  const result: GrokOAuthResult = { accessToken };
  if (typeof obj.expires_in === 'number' && Number.isFinite(obj.expires_in)) {
    result.expiresAt = Date.now() + obj.expires_in * 1000;
  }
  if (typeof obj.refresh_token === 'string' && obj.refresh_token.length > 0) {
    result.refreshToken = obj.refresh_token;
  }
  if (typeof obj.refresh_token_expires_in === 'number' && Number.isFinite(obj.refresh_token_expires_in)) {
    result.refreshExpiresAt = Date.now() + obj.refresh_token_expires_in * 1000;
  }
  return result;
}

/**
 * Poll the token endpoint with the device_code until the user authorizes,
 * denies, the code expires, or the overall timeout is reached (RFC 8628 §3.4).
 *
 * Error codes per RFC 8628 §3.5:
 *   authorization_pending → keep polling (normal)
 *   slow_down             → back off (increase interval by 5s)
 *   expired               → device_code expired → fatal
 *   denied                → user denied → fatal
 *   access_denied         → (some providers) → fatal
 */
export async function pollForDeviceToken(options: {
  clientId: string;
  deviceCode: string;
  interval: number;
  timeoutMs: number;
  tokenEndpoint?: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<GrokOAuthResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleepImpl ?? defaultSleep;
  const endpoint = options.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT;
  const deadline = Date.now() + options.timeoutMs;
  let interval = Math.max(options.interval, 1);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() >= deadline) {
      throw new GrokOAuthError('Device authorization timed out waiting for user approval', 'timeout');
    }

    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: DEVICE_GRANT_TYPE,
          client_id: options.clientId,
          device_code: options.deviceCode,
        }).toString(),
      });
    } catch (err) {
      throw new GrokOAuthError(
        `Token poll network error: ${err instanceof Error ? err.message : String(err)}`,
        'poll_network_error',
      );
    }

    // Success: 200 with access_token.
    if (response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch (err) {
        throw new GrokOAuthError(
          `Token response invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!body || typeof body !== 'object') {
        throw new GrokOAuthError('Token response is not an object');
      }
      const obj = body as Record<string, unknown>;
      const accessToken = obj.access_token;
      if (typeof accessToken !== 'string' || accessToken.length === 0) {
        throw new GrokOAuthError('Token response missing access_token', 'no_access_token');
      }
      return parseTokenResponseBody(obj, accessToken);
    }

    // Error: parse the OAuth error code to decide whether to keep polling.
    let errBody: Record<string, unknown> = {};
    try {
      const parsed = await response.json();
      if (parsed && typeof parsed === 'object') errBody = parsed as Record<string, unknown>;
    } catch {
      // Non-JSON error body — treat as transient and keep polling unless 4xx is definitive.
    }
    const errorCode = typeof errBody.error === 'string' ? errBody.error : `http_${response.status}`;

    switch (errorCode) {
      case 'authorization_pending':
        await sleep(interval * 1000);
        continue;
      case 'slow_down':
        // RFC 8628 §3.5: increase the interval by 5 seconds.
        interval += 5;
        await sleep(interval * 1000);
        continue;
      case 'expired_token':
      case 'expired':
        throw new GrokOAuthError('Device code expired before user authorized', 'expired');
      case 'access_denied':
      case 'denied':
        throw new GrokOAuthError('User denied the authorization request', 'denied');
      case 'invalid_grant':
        throw new GrokOAuthError('Device code rejected (invalid_grant)', 'invalid_grant');
      default:
        // Unknown error — surface it rather than polling forever.
        throw new GrokOAuthError(
          `Token poll error: ${errorCode}${typeof errBody.error_description === 'string' ? ` — ${errBody.error_description}` : ''}`,
          errorCode,
        );
    }
  }
}

/**
 * Run the complete Device Authorization Grant flow.
 *
 * Steps:
 *  1. Request a device code (user_code + verification_uri)
 *  2. Call onUserCode() so the caller can display the code/URL to the user
 *  3. Open the verification URI in the browser
 *  4. Poll the token endpoint until authorized / denied / timed out
 *
 * @throws GrokOAuthError on any failure (network, denied, expired, timeout).
 */
export async function runGrokOAuthFlow(options: GrokOAuthOptions = {}): Promise<GrokOAuthResult> {
  const clientId = options.clientId || process.env.GROK_OAUTH_CLIENT_ID || DEFAULT_GROK_OAUTH_CLIENT_ID;
  if (!clientId || clientId.trim().length === 0) {
    throw new GrokOAuthError('Missing clientId', 'no_client_id');
  }

  // Step 1: request device code.
  const deviceAuth = await requestDeviceCode({
    clientId,
    scopes: options.scopes,
    deviceCodeEndpoint: options.deviceCodeEndpoint,
    fetchImpl: options.fetchImpl,
  });

  // Step 2: surface the user_code + verification_uri to the caller.
  if (options.onUserCode) {
    await options.onUserCode(deviceAuth);
  }

  // Step 3: open the browser to the verification URI (best-effort, non-blocking).
  // Prefer verification_uri_complete when provided (pre-fills the user_code).
  try {
    await openBrowser(deviceAuth.verificationUriComplete ?? deviceAuth.verificationUri);
  } catch {
    // Browser launch is best-effort — the user can still visit the URL manually
    // (the code was already surfaced via onUserCode).
  }

  // Step 4: poll for the token. Timeout is the lesser of the overall timeout
  // and the device_code lifetime (xAI will reject an expired code anyway).
  const timeoutMs = options.timeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS;
  const effectiveTimeout = Math.min(timeoutMs, deviceAuth.expiresIn * 1000);

  return pollForDeviceToken({
    clientId,
    deviceCode: deviceAuth.deviceCode,
    interval: deviceAuth.interval,
    timeoutMs: effectiveTimeout,
    tokenEndpoint: options.tokenEndpoint,
    fetchImpl: options.fetchImpl,
    sleepImpl: options.sleepImpl,
  });
}

/**
 * Exchange a refresh token for a new access token (RFC 6749 §6).
 *
 * Reuses the same xAI token endpoint as the device flow. The provider MAY
 * rotate the refresh_token: callers should treat the returned `refreshToken`
 * (if any) as the new authoritative value and persist it. If the provider
 * does NOT return a new refresh_token, the caller keeps the previous one.
 *
 * Consumed by refreshRegistry.ts (grokRefreshAdapter) for auto-refresh.
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

  const endpoint = options.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT;
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

  return parseTokenResponseBody(obj, accessToken);
}

/**
 * Open the given URL in the user's default browser. Cross-platform via
 * child_process. Safe to call from Node 20+ — no shell injection (uses
 * spawn with args array).
 */
export async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import('node:child_process');
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
        child.unref();
        resolve();
      });
      setTimeout(() => resolve(), 100);
    } catch (err) {
      reject(err);
    }
  });
}
