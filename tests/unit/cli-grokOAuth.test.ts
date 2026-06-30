/**
 * Tests for grokOAuth — Device Authorization Grant (RFC 8628).
 *
 * xAI does not support the browser-redirect Authorization Code Grant; the
 * device flow is the supported path. These tests cover device-code request,
 * token polling (pending → authorized, slow_down, denied, expired), the full
 * runGrokOAuthFlow, and refreshGrokToken.
 */
import { describe, it, expect } from 'vitest';
import {
  requestDeviceCode,
  pollForDeviceToken,
  runGrokOAuthFlow,
  refreshGrokToken,
  DEFAULT_GROK_OAUTH_CLIENT_ID,
  DEFAULT_GROK_OAUTH_SCOPES,
  DEFAULT_DEVICE_CODE_ENDPOINT,
  DEFAULT_TOKEN_ENDPOINT,
  DEVICE_GRANT_TYPE,
  GrokOAuthError,
} from '../../src/cli/grokOAuth.js';

/** Build a fetch mock from a sequence of canned responses. */
function makeFetchMock(responses: Array<{ body: unknown; status: number; match?: (url: string) => boolean }>): typeof fetch {
  let callIndex = 0;
  const calls: string[] = [];
  const fn = (async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url.toString();
    calls.push(u);
    // Prefer a match by predicate, else consume in order.
    const byPredicate = responses.find((r) => r.match?.(u));
    const response = byPredicate ?? responses[Math.min(callIndex, responses.length - 1)];
    if (!byPredicate) callIndex++;
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return fn;
}

describe('requestDeviceCode (RFC 8628)', () => {
  it('POSTs client_id + scope to the device-code endpoint and returns parsed fields', async () => {
    let capturedBody: string | null = null;
    let capturedUrl: string | null = null;
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      capturedBody = typeof init?.body === 'string' ? init.body : null;
      return new Response(
        JSON.stringify({
          device_code: 'dev-code-123',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://auth.x.ai/device',
          verification_uri_complete: 'https://auth.x.ai/device?user_code=ABCD-EFGH',
          expires_in: 900,
          interval: 7,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    const result = await requestDeviceCode({ clientId: 'test-client', fetchImpl: fetchMock });

    expect(capturedUrl).toBe(DEFAULT_DEVICE_CODE_ENDPOINT);
    expect(capturedBody).toContain('client_id=test-client');
    // URLSearchParams encodes spaces as '+' and ':' as '%3A'.
    expect(capturedBody).toContain(
      `scope=${DEFAULT_GROK_OAUTH_SCOPES.join('+').replace(/:/g, '%3A')}`,
    );
    expect(result.deviceCode).toBe('dev-code-123');
    expect(result.userCode).toBe('ABCD-EFGH');
    expect(result.verificationUri).toBe('https://auth.x.ai/device');
    expect(result.verificationUriComplete).toBe('https://auth.x.ai/device?user_code=ABCD-EFGH');
    expect(result.expiresIn).toBe(900);
    expect(result.interval).toBe(7);
  });

  it('uses sensible defaults when expires_in/interval are omitted', async () => {
    const fetchMock = makeFetchMock([{
      body: { device_code: 'dc', user_code: 'UC', verification_uri: 'https://x.ai/d' },
      status: 200,
    }]);
    const result = await requestDeviceCode({ clientId: 'c', fetchImpl: fetchMock });
    expect(result.expiresIn).toBe(1800);
    expect(result.interval).toBe(5);
  });

  it('throws GrokOAuthError when device_code is missing', async () => {
    const fetchMock = makeFetchMock([{
      body: { user_code: 'UC', verification_uri: 'https://x.ai/d' },
      status: 200,
    }]);
    await expect(requestDeviceCode({ clientId: 'c', fetchImpl: fetchMock }))
      .rejects.toBeInstanceOf(GrokOAuthError);
  });

  it('throws GrokOAuthError on HTTP error', async () => {
    const fetchMock = makeFetchMock([{ body: { error: 'invalid_client' }, status: 401 }]);
    await expect(requestDeviceCode({ clientId: 'bad', fetchImpl: fetchMock }))
      .rejects.toMatchObject({ name: 'GrokOAuthError' });
  });
});

describe('pollForDeviceToken (RFC 8628 §3.4)', () => {
  it('returns the token once authorization succeeds (after a pending poll)', async () => {
    let polls = 0;
    const fetchMock = (async () => {
      polls++;
      if (polls === 1) {
        return new Response(JSON.stringify({ error: 'authorization_pending' }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        access_token: 'tok-xyz',
        expires_in: 3600,
        refresh_token: 'rt',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const result = await pollForDeviceToken({
      clientId: 'c', deviceCode: 'dc', interval: 1, timeoutMs: 5_000,
      fetchImpl: fetchMock,
      // No-op sleep so the test runs fast.
      sleepImpl: async () => {},
    });

    expect(result.accessToken).toBe('tok-xyz');
    expect(result.refreshToken).toBe('rt');
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(polls).toBe(2);
  });

  it('backs off (increases interval) on slow_down', async () => {
    let polls = 0;
    const intervalsUsed: number[] = [];
    const fetchMock = (async () => {
      polls++;
      if (polls <= 2) {
        return new Response(JSON.stringify({ error: 'slow_down' }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ access_token: 'ok' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    await pollForDeviceToken({
      clientId: 'c', deviceCode: 'dc', interval: 2, timeoutMs: 10_000,
      fetchImpl: fetchMock,
      sleepImpl: async (ms) => { intervalsUsed.push(ms); },
    });

    // RFC 8628 §3.5: on slow_down the interval is increased by 5s BEFORE the
    // next sleep. Starting interval 2 → first sleep 7s, second sleep 12s.
    expect(intervalsUsed.length).toBe(2);
    expect(intervalsUsed[0]).toBe(7000);  // (2 + 5) * 1000
    expect(intervalsUsed[1]).toBe(12000); // (7 + 5) * 1000
  });

  it('throws GrokOAuthError (denied) when user denies authorization', async () => {
    const fetchMock = makeFetchMock([{ body: { error: 'access_denied' }, status: 400 }]);
    await expect(pollForDeviceToken({
      clientId: 'c', deviceCode: 'dc', interval: 1, timeoutMs: 5_000,
      fetchImpl: fetchMock, sleepImpl: async () => {},
    })).rejects.toMatchObject({ name: 'GrokOAuthError', code: 'denied' });
  });

  it('throws GrokOAuthError (expired) when device code expires', async () => {
    const fetchMock = makeFetchMock([{ body: { error: 'expired_token' }, status: 400 }]);
    await expect(pollForDeviceToken({
      clientId: 'c', deviceCode: 'dc', interval: 1, timeoutMs: 5_000,
      fetchImpl: fetchMock, sleepImpl: async () => {},
    })).rejects.toMatchObject({ name: 'GrokOAuthError', code: 'expired' });
  });

  it('throws GrokOAuthError (timeout) when the overall timeout elapses', async () => {
    // Always pending — never resolves. Timeout must fire.
    const fetchMock = makeFetchMock([{ body: { error: 'authorization_pending' }, status: 400 }]);
    await expect(pollForDeviceToken({
      clientId: 'c', deviceCode: 'dc', interval: 1, timeoutMs: 0,
      fetchImpl: fetchMock, sleepImpl: async () => {},
    })).rejects.toMatchObject({ name: 'GrokOAuthError', code: 'timeout' });
  });

  it('sends grant_type=device_code + client_id + device_code in the poll body', async () => {
    let capturedBody: string | null = null;
    const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = typeof init?.body === 'string' ? init.body : null;
      return new Response(JSON.stringify({ access_token: 't' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    await pollForDeviceToken({
      clientId: 'cid', deviceCode: 'dcode', interval: 1, timeoutMs: 5_000,
      fetchImpl: fetchMock, sleepImpl: async () => {},
    });
    expect(capturedBody).toContain(`grant_type=${encodeURIComponent(DEVICE_GRANT_TYPE)}`);
    expect(capturedBody).toContain('client_id=cid');
    expect(capturedBody).toContain('device_code=dcode');
  });
});

describe('runGrokOAuthFlow (device flow, fully mocked)', () => {
  it('completes device flow end-to-end and calls onUserCode with the code', async () => {
    let capturedUserCode: string | null = null;
    let capturedUri: string | null = null;
    const fetchMock = makeFetchMock([
      // device-code request
      {
        status: 200,
        body: {
          device_code: 'dev-flow',
          user_code: 'ZZZZ-9999',
          verification_uri: 'https://auth.x.ai/device',
          verification_uri_complete: 'https://auth.x.ai/device?user_code=ZZZZ-9999',
          expires_in: 900,
          interval: 5,
        },
        match: (u) => u.includes('/device/code'),
      },
      // token poll — success on first try
      {
        status: 200,
        body: { access_token: 'flow-token', expires_in: 3600, refresh_token: 'rt-flow' },
        match: (u) => u.includes('/token'),
      },
    ]);

    const result = await runGrokOAuthFlow({
      clientId: 'test-client',
      fetchImpl: fetchMock,
      sleepImpl: async () => {},
      onUserCode: async (info) => {
        capturedUserCode = info.userCode;
        capturedUri = info.verificationUri;
      },
    });

    expect(result.accessToken).toBe('flow-token');
    expect(result.refreshToken).toBe('rt-flow');
    expect(capturedUserCode).toBe('ZZZZ-9999');
    expect(capturedUri).toBe('https://auth.x.ai/device');
  });
});

describe('refreshGrokToken', () => {
  it('returns a new token on success', async () => {
    const fetchMock = makeFetchMock([{
      body: { access_token: 'refreshed', expires_in: 3600, refresh_token: 'rt2' }, status: 200,
    }]);
    const result = await refreshGrokToken({
      clientId: 'c', refreshToken: 'rt1', fetchImpl: fetchMock,
    });
    expect(result.accessToken).toBe('refreshed');
    expect(result.refreshToken).toBe('rt2');
  });

  it('defaults to the xAI token endpoint', async () => {
    let capturedUrl: string | null = null;
    const fetchMock = (async (url: string | URL | Request) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      return new Response(JSON.stringify({ access_token: 't' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    await refreshGrokToken({ clientId: 'c', refreshToken: 'rt', fetchImpl: fetchMock });
    expect(capturedUrl).toBe(DEFAULT_TOKEN_ENDPOINT);
  });

  it('throws GrokOAuthError on missing refreshToken', async () => {
    await expect(refreshGrokToken({ clientId: 'c', refreshToken: '' }))
      .rejects.toMatchObject({ name: 'GrokOAuthError', code: 'no_refresh_token' });
  });
});

describe('default constants', () => {
  it('uses the xAI public OAuth client', () => {
    expect(DEFAULT_GROK_OAUTH_CLIENT_ID).toBe('b1a00492-073a-47ea-816f-4c329264a828');
  });
  it('device-code endpoint points at auth.x.ai', () => {
    expect(DEFAULT_DEVICE_CODE_ENDPOINT).toBe('https://auth.x.ai/oauth2/device/code');
  });
  it('token endpoint points at auth.x.ai', () => {
    expect(DEFAULT_TOKEN_ENDPOINT).toBe('https://auth.x.ai/oauth2/token');
  });
  it('device grant type is the RFC 8628 URN', () => {
    expect(DEVICE_GRANT_TYPE).toBe('urn:ietf:params:oauth:grant-type:device_code');
  });
  it('scopes include openid + api:access + offline_access', () => {
    expect(DEFAULT_GROK_OAUTH_SCOPES).toContain('openid');
    expect(DEFAULT_GROK_OAUTH_SCOPES).toContain('api:access');
    expect(DEFAULT_GROK_OAUTH_SCOPES).toContain('offline_access');
  });
});
