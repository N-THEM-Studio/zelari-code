import { describe, it, expect, vi } from 'vitest';
import {
  decodeJwtClaims,
  extractChatgptAccountId,
  refreshChatgptToken,
  runChatgptDeviceFlow,
  startChatgptDeviceAuth,
  ChatgptOAuthError,
  CHATGPT_DEVICE_CODE_URL,
  CHATGPT_DEVICE_TOKEN_URL,
  CHATGPT_DEVICE_VERIFY_URL,
  CHATGPT_TOKEN_URL,
} from '../../src/cli/chatgptOAuth.js';

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('chatgptOAuth', () => {
  it('extracts chatgpt_account_id from an id_token payload', () => {
    const payload = Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' },
      }),
    ).toString('base64url');
    const jwt = `hdr.${payload}.sig`;
    expect(decodeJwtClaims(jwt)['https://api.openai.com/auth']).toBeTruthy();
    expect(extractChatgptAccountId(jwt)).toBe('acct-1');
  });

  it('runChatgptDeviceFlow posts JSON client_id then polls device_auth_id', async () => {
    const calls: Array<{ url: string; body: string; contentType: string }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      const body = String(init?.body ?? '');
      const headers = init?.headers as Record<string, string> | undefined;
      const contentType = headers?.['Content-Type'] ?? headers?.['content-type'] ?? '';
      calls.push({ url: u, body, contentType });
      if (u === CHATGPT_DEVICE_CODE_URL) {
        return jsonResp({
          device_auth_id: 'dev-auth',
          user_code: 'ABCD',
          interval: '5',
        });
      }
      if (u === CHATGPT_DEVICE_TOKEN_URL) {
        return jsonResp({
          authorization_code: 'auth-code',
          code_challenge: 'ch',
          code_verifier: 'server-verifier',
        });
      }
      if (u === CHATGPT_TOKEN_URL) {
        expect(body).toContain('grant_type=authorization_code');
        expect(body).toContain('code=auth-code');
        expect(body).toContain('code_verifier=server-verifier');
        return jsonResp({
          access_token: 'at-1',
          refresh_token: 'rt-1',
          expires_in: 3600,
        });
      }
      return jsonResp({ error: 'unexpected' }, 500);
    }) as unknown as typeof fetch;

    const seen: string[] = [];
    const result = await runChatgptDeviceFlow({
      fetchImpl: fetchMock,
      sleepImpl: async () => undefined,
      onUserCode: async () => undefined,
      openBrowserImpl: async (url) => {
        seen.push(url);
      },
    });
    expect(result.accessToken).toBe('at-1');
    expect(result.refreshToken).toBe('rt-1');
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(seen[0]).toBe(`${CHATGPT_DEVICE_VERIFY_URL}?user_code=ABCD`);

    const start = calls.find((c) => c.url === CHATGPT_DEVICE_CODE_URL);
    expect(start?.contentType).toBe('application/json');
    expect(JSON.parse(start!.body)).toEqual({
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    });

    const poll = calls.find((c) => c.url === CHATGPT_DEVICE_TOKEN_URL);
    expect(poll?.contentType).toBe('application/json');
    expect(JSON.parse(poll!.body)).toEqual({
      device_auth_id: 'dev-auth',
      user_code: 'ABCD',
    });
  });

  it('treats device-token 403 as authorization_pending', async () => {
    let polls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u === CHATGPT_DEVICE_CODE_URL) {
        return jsonResp({ device_auth_id: 'dev', user_code: 'ZZ', interval: 1 });
      }
      if (u === CHATGPT_DEVICE_TOKEN_URL) {
        polls += 1;
        if (polls === 1) return jsonResp({}, 403);
        return jsonResp({ authorization_code: 'c', code_verifier: 'v' });
      }
      return jsonResp({ access_token: 'at' });
    }) as unknown as typeof fetch;

    const result = await runChatgptDeviceFlow({
      fetchImpl: fetchMock,
      sleepImpl: async () => undefined,
      onUserCode: async () => undefined,
      openBrowserImpl: async () => undefined,
    });
    expect(result.accessToken).toBe('at');
    expect(polls).toBe(2);
  });

  it('startChatgptDeviceAuth returns user_code without polling', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u === CHATGPT_DEVICE_CODE_URL) {
        return jsonResp({
          device_auth_id: 'dev-auth',
          user_code: 'WXYZ',
          interval: 7,
        });
      }
      return jsonResp({ error: 'should-not-poll' }, 500);
    }) as unknown as typeof fetch;
    const session = await startChatgptDeviceAuth({ fetchImpl: fetchMock });
    expect(session).toMatchObject({
      deviceAuthId: 'dev-auth',
      userCode: 'WXYZ',
      interval: 7,
    });
    expect(session.verificationUri).toContain('user_code=WXYZ');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('includes OpenAI error body in device-code HTTP 400', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResp({ error: { message: 'invalid client_id' } }, 400),
    ) as unknown as typeof fetch;
    await expect(
      runChatgptDeviceFlow({
        fetchImpl: fetchMock,
        sleepImpl: async () => undefined,
        onUserCode: async () => undefined,
        openBrowserImpl: async () => undefined,
      }),
    ).rejects.toMatchObject({
      name: 'ChatgptOAuthError',
      message: expect.stringContaining('invalid client_id'),
    });
  });

  it('refreshChatgptToken posts refresh_token grant', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      expect(body).toContain('grant_type=refresh_token');
      expect(body).toContain('refresh_token=rt');
      return jsonResp({ access_token: 'fresh', expires_in: 60, refresh_token: 'rt2' });
    }) as unknown as typeof fetch;
    const result = await refreshChatgptToken({ refreshToken: 'rt', fetchImpl: fetchMock });
    expect(result.accessToken).toBe('fresh');
    expect(result.refreshToken).toBe('rt2');
  });

  it('refreshChatgptToken maps 401 to invalid_grant', async () => {
    const fetchMock = vi.fn(async () => jsonResp({ error: 'invalid_grant' }, 401)) as unknown as typeof fetch;
    await expect(refreshChatgptToken({ refreshToken: 'bad', fetchImpl: fetchMock })).rejects.toBeInstanceOf(
      ChatgptOAuthError,
    );
  });
});
