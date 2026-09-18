import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mintMuseModelKey,
  readMuseCliAuth,
  refreshMuseToken,
  requestMuseDeviceCode,
  runMuseOAuthFlow,
  MuseOAuthError,
} from '../../src/cli/museOAuth.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('museOAuth', () => {
  const envBackup = { ...process.env };
  beforeEach(() => {
    process.env = { ...envBackup };
    delete process.env.MUSE_OAUTH_CLIENT_ID;
    // Hermetic: never pick up a real `muse login` session from the host.
    process.env.MUSE_CONFIG_DIR = join(tmpdir(), 'zelari-muse-test-absent');
    vi.restoreAllMocks();
  });
  afterEach(() => {
    process.env = { ...envBackup };
    vi.restoreAllMocks();
  });

  it('requests a device code and parses the RFC 8628 fields', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        device_code: 'dev-1',
        user_code: 'MUSE-123',
        verification_uri: 'https://auth.meta.com/device',
        verification_uri_complete: 'https://auth.meta.com/device?code=MUSE-123',
        expires_in: 900,
        interval: 2,
      }),
    );
    const auth = await requestMuseDeviceCode({
      clientId: 'cid',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(auth).toMatchObject({
      deviceCode: 'dev-1',
      userCode: 'MUSE-123',
      verificationUri: 'https://auth.meta.com/device',
      expiresIn: 900,
      interval: 2,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('mints a model key from the access token (api_key shape)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ api_key: 'mk-abc', expires_in: 3600 }));
    const minted = await mintMuseModelKey({
      accessToken: 'oidc-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(minted.apiKey).toBe('mk-abc');
    expect(minted.expiresAt).toBeGreaterThan(Date.now());
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer oidc-token');
  });

  it('mints from alternative key shapes (data.key)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { key: 'mk-alt' } }));
    const minted = await mintMuseModelKey({
      accessToken: 'oidc-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(minted.apiKey).toBe('mk-alt');
  });

  it('runs the full device flow then mints (mocked fetch sequence)', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = String((init?.body as string) ?? '');
      if (body.includes('device_code=dev-1')) {
        return jsonResponse({ access_token: 'oidc-1', expires_in: 600, refresh_token: 'rt-1' });
      }
      if (url.includes('device/code')) {
        return jsonResponse({
          device_code: 'dev-1',
          user_code: 'MUSE-9',
          verification_uri: 'https://auth.meta.com/device',
          expires_in: 900,
          interval: 0,
        });
      }
      return jsonResponse({ api_key: 'mk-minted', expires_in: 7200 });
    });
    const seen: string[] = [];
    const result = await runMuseOAuthFlow({
      clientId: 'cid',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openBrowserImpl: async () => undefined,
      sleepImpl: async () => undefined,
      onUserCode: (info) => {
        seen.push(info.userCode);
      },
    });
    expect(seen).toEqual(['MUSE-9']);
    expect(result.accessToken).toBe('mk-minted');
    expect(result.refreshToken).toBe('rt-1');
  });

  it('import path: existing OIDC token mints without a device round-trip', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ key: 'mk-imported' }));
    const result = await runMuseOAuthFlow({
      accessToken: 'oidc-imported',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openBrowserImpl: async () => {
        throw new Error('browser must not open on import path');
      },
    });
    expect(result.accessToken).toBe('mk-imported');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refresh exchanges the OIDC token then mints a fresh model key', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('muse-code/key')) return jsonResponse({ api_key: 'mk-fresh' });
      return jsonResponse({ access_token: 'oidc-2', refresh_token: 'rt-2' });
    });
    const result = await refreshMuseToken({
      clientId: 'cid',
      refreshToken: 'rt-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.accessToken).toBe('mk-fresh');
    expect(result.refreshToken).toBe('rt-2');
  });

  it('refresh without client id fails closed with no_client_id', async () => {
    await expect(
      refreshMuseToken({
        refreshToken: 'rt-1',
        fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ name: 'MuseOAuthError', code: 'no_client_id' });
  });

  it('reads an existing muse CLI auth.json (import path)', () => {
    const auth = readMuseCliAuth({
      readFileImpl: () =>
        JSON.stringify({ access_token: 'oidc-cli', refresh_token: 'rt-cli' }),
    });
    expect(auth).toMatchObject({ accessToken: 'oidc-cli', refreshToken: 'rt-cli' });
  });

  it('returns null when no muse CLI session exists', () => {
    const auth = readMuseCliAuth({
      readFileImpl: () => {
        throw new Error('ENOENT');
      },
    });
    expect(auth).toBeNull();
  });

  it('registers a muse refresh impl by default', async () => {
    const { registerDefaultRefreshImpls, getRefreshImpl } = await import(
      '../../src/cli/refreshRegistry.js'
    );
    registerDefaultRefreshImpls();
    expect(getRefreshImpl('muse')).not.toBeNull();
    expect(MuseOAuthError).toBeDefined();
  });
});
