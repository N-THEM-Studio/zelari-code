import { describe, it, expect, vi } from 'vitest';
import {
  decodeJwtClaims,
  extractChatgptAccountId,
  refreshChatgptToken,
  runChatgptDeviceFlow,
  ChatgptOAuthError,
  CHATGPT_DEVICE_CODE_URL,
  CHATGPT_DEVICE_TOKEN_URL,
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

  it('runChatgptDeviceFlow polls then exchanges the authorization_code', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      calls.push(u);
      if (u === CHATGPT_DEVICE_CODE_URL) {
        return jsonResp({
          device_code: 'dev',
          user_code: 'ABCD',
          verification_uri: 'https://auth.openai.com/device',
          verification_uri_complete: 'https://auth.openai.com/device?user_code=ABCD',
        });
      }
      if (u === CHATGPT_DEVICE_TOKEN_URL) {
        return jsonResp({ authorization_code: 'auth-code' });
      }
      if (u === CHATGPT_TOKEN_URL) {
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
      openBrowserImpl: async (url) => {
        seen.push(url);
      },
    });
    expect(result.accessToken).toBe('at-1');
    expect(result.refreshToken).toBe('rt-1');
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(seen[0]).toContain('user_code=ABCD');
    expect(calls).toContain(CHATGPT_DEVICE_CODE_URL);
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
