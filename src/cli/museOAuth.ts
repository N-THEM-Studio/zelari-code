/**
 * museOAuth — Muse (Meta Muse Spark) subscription login.
 *
 * Two-step flow (mirrors third-party Muse integrations):
 *   1. OIDC device authorization grant → access_token (+ refresh_token).
 *   2. Mint a Model API key: POST {keyEndpoint} with the access token as
 *      Bearer. api.meta.ai does NOT accept the OIDC token directly.
 *
 * Endpoints are env-overridable because Meta's device endpoints are
 * undocumented and may move; defaults below are best-effort values
 * reported by third-party integrations:
 *   - Device code:  https://auth.meta.com/oauth2/device/code
 *   - Token:        https://auth.meta.com/oauth2/token
 *   - Key mint:     https://api.meta.ai/muse-code/key
 *   - Chat base:    https://api.meta.ai/v1 (Responses-compatible)
 *
 * Env:
 *   MUSE_OAUTH_CLIENT_ID, MUSE_OAUTH_SCOPE,
 *   MUSE_OAUTH_DEVICE_CODE_ENDPOINT, MUSE_OAUTH_TOKEN_ENDPOINT,
 *   MUSE_OAUTH_KEY_ENDPOINT, MUSE_CONFIG_DIR
 *
 * Import path: when the user already ran `muse login`, the session is read
 * from `$MUSE_CONFIG_DIR/auth.json` (or `~/.config/muse/auth.json`) — no
 * client id or browser round-trip needed. The official CLI writes schema v1
 * (`{ schema_version, providers: { meta: { access_token, api_key,
 * api_base_url } } }`): `api_key` is already a Model API key and is used
 * as-is; `access_token` (OIDC, `dca:` prefix) only ever triggers a mint.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { openBrowser } from './grokOAuth.js';

export const DEFAULT_MUSE_DEVICE_CODE_ENDPOINT =
  'https://auth.meta.com/oauth2/device/code';
export const DEFAULT_MUSE_TOKEN_ENDPOINT = 'https://auth.meta.com/oauth2/token';
export const DEFAULT_MUSE_KEY_ENDPOINT = 'https://api.meta.ai/muse-code/key';
export const DEFAULT_MUSE_BASE_URL = 'https://api.meta.ai/v1';
export const DEFAULT_MUSE_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
] as const;
export const MUSE_DEVICE_GRANT_TYPE =
  'urn:ietf:params:oauth:grant-type:device_code';
export const DEFAULT_MUSE_OAUTH_TIMEOUT_MS = 300_000;

export interface MuseOAuthResult {
  /** Minted Model API key — this is what Zelari stores as the apiKey. */
  accessToken: string;
  expiresAt?: number;
  /** OIDC refresh token (used to mint a fresh model key on refresh). */
  refreshToken?: string;
  /** `api_base_url` from the import session (when it differs from the default). */
  baseUrl?: string;
}

export interface MuseDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export interface MuseOAuthOptions {
  clientId?: string;
  scopes?: readonly string[];
  deviceCodeEndpoint?: string;
  tokenEndpoint?: string;
  keyEndpoint?: string;
  /** Pre-existing OIDC access token (import path) — skips the device flow. */
  accessToken?: string;
  timeoutMs?: number;
  onUserCode?: (info: MuseDeviceAuthorization) => void | Promise<void>;
  sleepImpl?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  openBrowserImpl?: (url: string) => Promise<void>;
}

export class MuseOAuthError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'MuseOAuthError';
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function resolveClientId(explicit?: string): string {
  const id = (explicit ?? process.env.MUSE_OAUTH_CLIENT_ID ?? '').trim();
  return id;
}

export async function requestMuseDeviceCode(options: {
  clientId: string;
  scopes?: readonly string[];
  deviceCodeEndpoint?: string;
  fetchImpl?: typeof fetch;
}): Promise<MuseDeviceAuthorization> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint =
    options.deviceCodeEndpoint ??
    process.env.MUSE_OAUTH_DEVICE_CODE_ENDPOINT ??
    DEFAULT_MUSE_DEVICE_CODE_ENDPOINT;
  const scopes = options.scopes ?? DEFAULT_MUSE_SCOPES;
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
        scope: [...scopes].join(' '),
      }).toString(),
    });
  } catch (err) {
    throw new MuseOAuthError(
      `Device code request network error: ${err instanceof Error ? err.message : String(err)}`,
      'device_code_network_error',
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new MuseOAuthError(
      `Device code request HTTP ${response.status}: ${text.slice(0, 200)}`,
      `device_code_http_${response.status}`,
    );
  }
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body || typeof body !== 'object') {
    throw new MuseOAuthError('Device code response is not an object');
  }
  const { device_code, user_code, verification_uri } = body as {
    device_code?: unknown;
    user_code?: unknown;
    verification_uri?: unknown;
  };
  if (typeof device_code !== 'string' || !device_code) {
    throw new MuseOAuthError('Device code response missing device_code', 'no_device_code');
  }
  if (typeof user_code !== 'string' || !user_code) {
    throw new MuseOAuthError('Device code response missing user_code', 'no_user_code');
  }
  if (typeof verification_uri !== 'string' || !verification_uri) {
    throw new MuseOAuthError(
      'Device code response missing verification_uri',
      'no_verification_uri',
    );
  }
  const complete = (body as Record<string, unknown>).verification_uri_complete;
  return {
    deviceCode: device_code,
    userCode: user_code,
    verificationUri: verification_uri,
    ...(typeof complete === 'string' && complete
      ? { verificationUriComplete: complete }
      : {}),
    expiresIn:
      typeof body.expires_in === 'number' && Number.isFinite(body.expires_in)
        ? body.expires_in
        : 1800,
    interval:
      typeof body.interval === 'number' && Number.isFinite(body.interval)
        ? body.interval
        : 5,
  };
}

async function pollMuseDeviceToken(options: {
  clientId: string;
  deviceCode: string;
  interval: number;
  timeoutMs: number;
  tokenEndpoint?: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<{ accessToken: string; expiresAt?: number; refreshToken?: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleepImpl ?? defaultSleep;
  const endpoint =
    options.tokenEndpoint ??
    process.env.MUSE_OAUTH_TOKEN_ENDPOINT ??
    DEFAULT_MUSE_TOKEN_ENDPOINT;
  const deadline = Date.now() + options.timeoutMs;
  let interval = Math.max(options.interval, 1);
  for (;;) {
    if (Date.now() >= deadline) {
      throw new MuseOAuthError(
        'Device authorization timed out waiting for user approval',
        'timeout',
      );
    }
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: MUSE_DEVICE_GRANT_TYPE,
        client_id: options.clientId,
        device_code: options.deviceCode,
      }).toString(),
    }).catch((err: unknown) => {
      throw new MuseOAuthError(
        `Token poll network error: ${err instanceof Error ? err.message : String(err)}`,
        'poll_network_error',
      );
    });
    if (response.ok) {
      const obj = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      const accessToken = obj?.access_token;
      if (typeof accessToken !== 'string' || !accessToken) {
        throw new MuseOAuthError('Token response missing access_token', 'no_access_token');
      }
      const out: { accessToken: string; expiresAt?: number; refreshToken?: string } = {
        accessToken,
      };
      if (typeof obj?.expires_in === 'number' && Number.isFinite(obj.expires_in)) {
        out.expiresAt = Date.now() + obj.expires_in * 1000;
      }
      if (typeof obj?.refresh_token === 'string' && obj.refresh_token) {
        out.refreshToken = obj.refresh_token;
      }
      return out;
    }
    const errBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const code =
      typeof errBody.error === 'string' ? errBody.error : `http_${response.status}`;
    if (code === 'authorization_pending') {
      await sleep(interval * 1000);
      continue;
    }
    if (code === 'slow_down') {
      interval += 5;
      await sleep(interval * 1000);
      continue;
    }
    if (code === 'expired_token' || code === 'expired') {
      throw new MuseOAuthError('Device code expired before user authorized', 'expired');
    }
    if (code === 'access_denied' || code === 'denied') {
      throw new MuseOAuthError('User denied the authorization request', 'denied');
    }
    throw new MuseOAuthError(`Token poll error: ${code}`, code);
  }
}

/** Exchange an OIDC access token for a Model API key usable on api.meta.ai. */
export async function mintMuseModelKey(options: {
  accessToken: string;
  keyEndpoint?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ apiKey: string; expiresAt?: number }> {
  if (!options.accessToken) throw new MuseOAuthError('Missing accessToken', 'no_access_token');
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint =
    options.keyEndpoint ??
    process.env.MUSE_OAUTH_KEY_ENDPOINT ??
    DEFAULT_MUSE_KEY_ENDPOINT;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new MuseOAuthError(
      `Key mint network error: ${err instanceof Error ? err.message : String(err)}`,
      'mint_network_error',
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const code =
      response.status === 400 || response.status === 401
        ? 'invalid_grant'
        : `http_${response.status}`;
    throw new MuseOAuthError(
      `Key mint HTTP ${response.status}: ${text.slice(0, 200)}`,
      code,
    );
  }
  const obj = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const candidates = [
    obj?.api_key,
    obj?.key,
    obj?.token,
    (obj?.data as Record<string, unknown> | undefined)?.api_key,
    (obj?.data as Record<string, unknown> | undefined)?.key,
  ];
  const apiKey = candidates.find((c): c is string => typeof c === 'string' && c.length > 0);
  if (!apiKey) {
    throw new MuseOAuthError('Key mint response missing api key', 'no_api_key');
  }
  const out: { apiKey: string; expiresAt?: number } = { apiKey };
  if (typeof obj?.expires_in === 'number' && Number.isFinite(obj.expires_in)) {
    out.expiresAt = Date.now() + obj.expires_in * 1000;
  }
  return out;
}

/** Credentials parsed from an official `muse login` session. */
export interface MuseCliAuth {
  /** Model API key (`LLM|…`) — usable as-is against api.meta.ai. */
  apiKey?: string;
  /** OIDC access token (`dca:…`) — only used to mint a model key. */
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  /** `api_base_url` declared by the muse CLI session. */
  baseUrl?: string;
}

const pickStr = (...candidates: unknown[]): string | undefined =>
  candidates.find((c): c is string => typeof c === 'string' && c.length > 0);

/** Read tokens from an existing `muse login` session (import path). */
export function readMuseCliAuth(options: {
  configDir?: string;
  readFileImpl?: (file: string) => string;
} = {}): MuseCliAuth | null {
  const dir =
    options.configDir ?? process.env.MUSE_CONFIG_DIR ?? path.join(homedir(), '.config', 'muse');
  const file = path.join(dir, 'auth.json');
  let raw: string;
  try {
    raw = options.readFileImpl ? options.readFileImpl(file) : readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    // Official schema v1 nests credentials per provider; legacy files kept
    // them flat at the top level. Entry wins, flat keys remain the fallback.
    const providers = obj.providers as Record<string, unknown> | undefined;
    const entry = (providers?.meta ?? providers?.muse) as Record<string, unknown> | undefined;
    const src: Record<string, unknown> =
      entry && typeof entry === 'object' ? entry : obj;
    const apiKey = pickStr(src.api_key, src.apiKey, obj.api_key);
    const accessToken = pickStr(
      src.access_token,
      src.accessToken,
      (src.tokens as Record<string, unknown> | undefined)?.access_token,
    );
    const refreshToken = pickStr(
      src.refresh_token,
      src.refreshToken,
      (src.tokens as Record<string, unknown> | undefined)?.refresh_token,
    );
    const baseUrl = pickStr(src.api_base_url, src.baseUrl, obj.api_base_url);
    if (!apiKey && !accessToken && !refreshToken) return null;
    const out: MuseCliAuth = {};
    if (apiKey) out.apiKey = apiKey;
    if (accessToken) out.accessToken = accessToken;
    if (refreshToken) out.refreshToken = refreshToken;
    if (baseUrl) out.baseUrl = baseUrl;
    const expiresRaw =
      typeof src.expires_at === 'number' && Number.isFinite(src.expires_at)
        ? src.expires_at
        : typeof obj.expires_at === 'number' && Number.isFinite(obj.expires_at)
          ? obj.expires_at
          : undefined;
    if (expiresRaw !== undefined) {
      out.expiresAt = expiresRaw > 1e12 ? expiresRaw : expiresRaw * 1000;
    }
    return out;
  } catch {
    return null;
  }
}

export async function runMuseOAuthFlow(
  options: MuseOAuthOptions = {},
): Promise<MuseOAuthResult> {
  const keyEndpoint =
    options.keyEndpoint ??
    process.env.MUSE_OAUTH_KEY_ENDPOINT ??
    DEFAULT_MUSE_KEY_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? fetch;

  // Import path: an explicit OIDC token, or an existing `muse login`
  // session, skips the device round-trip — no client id needed.
  if (options.accessToken) {
    const minted = await mintMuseModelKey({ accessToken: options.accessToken, keyEndpoint, fetchImpl });
    const cli = readMuseCliAuth();
    return {
      accessToken: minted.apiKey,
      ...(minted.expiresAt !== undefined ? { expiresAt: minted.expiresAt } : {}),
      ...(cli?.refreshToken ? { refreshToken: cli.refreshToken } : {}),
      ...(cli?.baseUrl ? { baseUrl: cli.baseUrl } : {}),
    };
  }
  const cliAuth = readMuseCliAuth();
  if (cliAuth) {
    // Schema v1 already carries a Model API key — use it as-is, zero network.
    if (cliAuth.apiKey) {
      return {
        accessToken: cliAuth.apiKey,
        ...(cliAuth.expiresAt !== undefined ? { expiresAt: cliAuth.expiresAt } : {}),
        ...(cliAuth.refreshToken ? { refreshToken: cliAuth.refreshToken } : {}),
        ...(cliAuth.baseUrl ? { baseUrl: cliAuth.baseUrl } : {}),
      };
    }
    if (cliAuth.accessToken) {
      const minted = await mintMuseModelKey({ accessToken: cliAuth.accessToken, keyEndpoint, fetchImpl });
      const expiresAt = minted.expiresAt ?? cliAuth.expiresAt;
      return {
        accessToken: minted.apiKey,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(cliAuth.refreshToken ? { refreshToken: cliAuth.refreshToken } : {}),
        ...(cliAuth.baseUrl ? { baseUrl: cliAuth.baseUrl } : {}),
      };
    }
  }

  const clientId = resolveClientId(options.clientId);
  if (!clientId) {
    throw new MuseOAuthError(
      'Missing Muse OAuth client id — set MUSE_OAUTH_CLIENT_ID or run `muse login` first (import path needs no client id).',
      'no_client_id',
    );
  }
  const deviceAuth = await requestMuseDeviceCode({
    clientId,
    scopes: options.scopes,
    deviceCodeEndpoint: options.deviceCodeEndpoint,
    fetchImpl,
  });
  if (options.onUserCode) {
    await options.onUserCode(deviceAuth);
  } else {
    // Headless / --login-oauth has no TUI callback: print the device page +
    // code. stderr: callers parse stdout as JSON.
    process.stderr.write(
      `[muse oauth] Open ${deviceAuth.verificationUriComplete ?? deviceAuth.verificationUri} and enter:\n  ${deviceAuth.userCode}\n`,
    );
  }
  try {
    await (options.openBrowserImpl ?? openBrowser)(
      deviceAuth.verificationUriComplete ?? deviceAuth.verificationUri,
    );
  } catch {
    // Best-effort — the user can visit the URL manually.
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_MUSE_OAUTH_TIMEOUT_MS;
  const token = await pollMuseDeviceToken({
    clientId,
    deviceCode: deviceAuth.deviceCode,
    interval: deviceAuth.interval,
    timeoutMs: Math.min(timeoutMs, deviceAuth.expiresIn * 1000),
    tokenEndpoint: options.tokenEndpoint,
    fetchImpl,
    sleepImpl: options.sleepImpl,
  });
  const minted = await mintMuseModelKey({ accessToken: token.accessToken, keyEndpoint, fetchImpl });
  const expiresAt = minted.expiresAt ?? token.expiresAt;
  return {
    accessToken: minted.apiKey,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
  };
}

/** Refresh: exchange the OIDC refresh token, then mint a fresh model key. */
export async function refreshMuseToken(options: {
  clientId?: string;
  refreshToken: string;
  tokenEndpoint?: string;
  keyEndpoint?: string;
  fetchImpl?: typeof fetch;
}): Promise<MuseOAuthResult> {
  const clientId = resolveClientId(options.clientId);
  if (!clientId) throw new MuseOAuthError('Missing clientId', 'no_client_id');
  if (!options.refreshToken) throw new MuseOAuthError('Missing refreshToken', 'no_refresh_token');
  const endpoint =
    options.tokenEndpoint ??
    process.env.MUSE_OAUTH_TOKEN_ENDPOINT ??
    DEFAULT_MUSE_TOKEN_ENDPOINT;
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
        client_id: clientId,
        refresh_token: options.refreshToken,
      }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new MuseOAuthError(
      `Token refresh network error: ${err instanceof Error ? err.message : String(err)}`,
      'refresh_network_error',
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const code =
      response.status === 400 || response.status === 401 ? 'invalid_grant' : `http_${response.status}`;
    throw new MuseOAuthError(`Token refresh HTTP ${response.status}: ${text.slice(0, 200)}`, code);
  }
  const obj = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const accessToken = obj?.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new MuseOAuthError('Token refresh response missing access_token', 'no_access_token');
  }
  const minted = await mintMuseModelKey({
    accessToken,
    keyEndpoint: options.keyEndpoint,
    fetchImpl,
  });
  const nextRefresh =
    typeof obj?.refresh_token === 'string' && obj.refresh_token
      ? obj.refresh_token
      : options.refreshToken;
  return {
    accessToken: minted.apiKey,
    ...(minted.expiresAt !== undefined ? { expiresAt: minted.expiresAt } : {}),
    refreshToken: nextRefresh,
  };
}

export function museOAuthConfigured(): boolean {
  return resolveClientId().length > 0 || readMuseCliAuth() !== null;
}
