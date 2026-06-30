/**
 * v3-T updated tests for grokOAuth — PKCE + discovery + SuperGrok scopes.
 *
 * Reference flow: https://github.com/toptoppy/supergrok-oauth (Python)
 * Our TypeScript port uses the same OAuth public client + PKCE S256.
 */
import { describe, it, expect } from 'vitest';
import {
  generatePkce,
  buildGrokAuthorizeUrl,
  exchangeGrokCode,
  fetchGrokDiscovery,
  runGrokOAuthFlow,
  DEFAULT_GROK_OAUTH_CLIENT_ID,
  DEFAULT_GROK_OAUTH_REDIRECT_PORT,
  DEFAULT_GROK_OAUTH_REDIRECT_PATH,
  DEFAULT_GROK_OAUTH_SCOPES,
  GrokOAuthError,
} from '../../src/cli/grokOAuth.js';

describe('generatePkce (v3-T)', () => {
  it('returns base64url verifier (43-128 chars) and matching sha256 challenge', () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    // Different each call
    const again = generatePkce();
    expect(again.verifier).not.toBe(verifier);
  });
});

describe('buildGrokAuthorizeUrl (v3-T PKCE)', () => {
  it('includes all required PKCE + state params', () => {
    const url = buildGrokAuthorizeUrl({
      clientId: 'test-client',
      redirectUri: 'http://127.0.0.1:56121/callback',
      codeChallenge: 'challenge-xyz',
      authorizeEndpoint: 'https://auth.x.ai/oauth/authorize',
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('client_id')).toBe('test-client');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('code_challenge')).toBe('challenge-xyz');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('state')).toBeTruthy();
    expect(parsed.searchParams.get('scope')).toContain('openid');
    expect(parsed.searchParams.get('scope')).toContain('api:access');
  });

  it('uses default xAI SuperGrok scopes when not provided', () => {
    const url = buildGrokAuthorizeUrl({
      clientId: 'c',
      redirectUri: 'http://127.0.0.1:56121/callback',
      codeChallenge: 'ch',
      authorizeEndpoint: 'https://auth.x.ai/oauth/authorize',
    });
    const scope = new URL(url).searchParams.get('scope') ?? '';
    expect(scope).toBe(DEFAULT_GROK_OAUTH_SCOPES.join(' '));
  });

  it('accepts custom scopes', () => {
    const url = buildGrokAuthorizeUrl({
      clientId: 'c',
      redirectUri: 'r',
      codeChallenge: 'ch',
      authorizeEndpoint: 'https://example.com/auth',
      scopes: ['openid', 'email'],
    });
    expect(new URL(url).searchParams.get('scope')).toBe('openid email');
  });
});

describe('exchangeGrokCode (v3-T PKCE)', () => {
  function makeFetchMock(jsonResponse: unknown, status = 200): typeof fetch {
    return (async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify(jsonResponse), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
  }

  it('returns accessToken + expiresAt on success', async () => {
    const fetchMock = makeFetchMock({
      access_token: 'sk-grok-token',
      expires_in: 3600,
      refresh_token: 'rt-abc',
      refresh_token_expires_in: 7_776_000, // 90 days
    });
    const result = await exchangeGrokCode({
      clientId: 'test-client',
      code: 'auth-code',
      codeVerifier: 'verifier-xyz',
      redirectUri: 'http://127.0.0.1:56121/callback',
      tokenEndpoint: 'https://auth.x.ai/oauth/token',
      fetchImpl: fetchMock,
    });
    expect(result.accessToken).toBe('sk-grok-token');
    expect(result.refreshToken).toBe('rt-abc');
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(result.refreshExpiresAt).toBeGreaterThan(Date.now() + 7_000_000);
  });

  it('throws GrokOAuthError on HTTP error', async () => {
    const fetchMock = makeFetchMock({ error: 'invalid_grant' }, 400);
    await expect(
      exchangeGrokCode({
        clientId: 'c',
        code: 'bad-code',
        codeVerifier: 'v',
        redirectUri: 'r',
        tokenEndpoint: 'https://auth.x.ai/oauth/token',
        fetchImpl: fetchMock,
      })
    ).rejects.toBeInstanceOf(GrokOAuthError);
  });

  it('omits expiresAt when provider does not return expires_in', async () => {
    const fetchMock = makeFetchMock({ access_token: 'tok' });
    const result = await exchangeGrokCode({
      clientId: 'c',
      code: 'x',
      codeVerifier: 'v',
      redirectUri: 'r',
      tokenEndpoint: 'https://auth.x.ai/oauth/token',
      fetchImpl: fetchMock,
    });
    expect(result.accessToken).toBe('tok');
    expect(result.expiresAt).toBeUndefined();
  });
});

describe('fetchGrokDiscovery (v3-T)', () => {
  it('parses authorization_endpoint + token_endpoint from discovery JSON', async () => {
    const fetchMock = (async () =>
      new Response(
        JSON.stringify({
          authorization_endpoint: 'https://auth.x.ai/oauth/authorize',
          token_endpoint: 'https://auth.x.ai/oauth/token',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as typeof fetch;
    const result = await fetchGrokDiscovery({ fetchImpl: fetchMock });
    expect(result.authorizationEndpoint).toBe('https://auth.x.ai/oauth/authorize');
    expect(result.tokenEndpoint).toBe('https://auth.x.ai/oauth/token');
  });

  it('throws on missing endpoints', async () => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({ foo: 'bar' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    await expect(fetchGrokDiscovery({ fetchImpl: fetchMock })).rejects.toBeInstanceOf(GrokOAuthError);
  });
});

describe('runGrokOAuthFlow (v3-T, fully mocked)', () => {
  it('completes full PKCE flow end-to-end with mocked fetch + browser', async () => {
    let openedUrl: string | null = null;
    const fetchMock = (async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('.well-known/openid-configuration')) {
        return new Response(
          JSON.stringify({
            authorization_endpoint: 'https://auth.x.ai/oauth/authorize',
            token_endpoint: 'https://auth.x.ai/oauth/token',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      // Token exchange
      return new Response(
        JSON.stringify({
          access_token: 'sk-grok-flow',
          expires_in: 3600,
          refresh_token: 'rt-flow',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    // Start the flow in the background — it will wait for callback.
    const flowPromise = runGrokOAuthFlow({
      issuer: 'https://auth.x.ai',
      onBrowserOpen: async (url) => {
        openedUrl = url;
        // Simulate the browser callback hitting our local server
        const parsed = new URL(url);
        const stateParam = parsed.searchParams.get('state');
        // After the browser opens, fire the callback server with code + state
        const port = 56121;
        setTimeout(async () => {
          await fetch(`http://127.0.0.1:${port}/callback?code=fake-auth-code&state=${stateParam}`);
        }, 50);
      },
      fetchImpl: fetchMock,
      callbackTimeoutMs: 5_000,
    });

    const result = await flowPromise;
    expect(result.accessToken).toBe('sk-grok-flow');
    expect(result.refreshToken).toBe('rt-flow');
    expect(openedUrl).toMatch(/^https:\/\/auth\.x\.ai\/oauth\/authorize\?/);
    const opened = new URL(openedUrl!);
    expect(opened.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('default constants (v3-T)', () => {
  it('uses xAI public OAuth client', () => {
    expect(DEFAULT_GROK_OAUTH_CLIENT_ID).toBeTruthy();
    expect(DEFAULT_GROK_OAUTH_CLIENT_ID.length).toBeGreaterThan(10);
  });
  it('redirect port = 56121', () => {
    expect(DEFAULT_GROK_OAUTH_REDIRECT_PORT).toBe(56121);
  });
  it('redirect path = /callback', () => {
    expect(DEFAULT_GROK_OAUTH_REDIRECT_PATH).toBe('/callback');
  });
  it('scopes include openid + api:access', () => {
    expect(DEFAULT_GROK_OAUTH_SCOPES).toContain('openid');
    expect(DEFAULT_GROK_OAUTH_SCOPES).toContain('api:access');
  });
});