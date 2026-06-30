import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { refreshGrokToken, GrokOAuthError } from '../../src/cli/grokOAuth.js';

/**
 * Tasks D.2.1 + D.2.4: refreshGrokToken function + tests.
 *
 * Covers:
 *   - Success path (200 + access_token + expires_in + refresh_token)
 *   - Variants (no expires_in, no refresh_token, both)
 *   - HTTP errors (400/401 → invalid_grant, 500 → http_500)
 *   - Network errors
 *   - Invalid JSON / non-object body
 *   - Missing access_token in body
 *   - Missing clientId / refreshToken input
 */
describe('refreshGrokToken (Task D.2.1)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('Success path', () => {
    it('returns { accessToken, expiresAt, refreshToken } on full response', async () => {
      const now = Date.now();
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'new-access-token-xyz',
            expires_in: 3600,
            refresh_token: 'new-refresh-token-abc',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      const result = await refreshGrokToken({
        clientId: 'test-client-id',
        refreshToken: 'old-refresh-token',
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      expect(result.accessToken).toBe('new-access-token-xyz');
      expect(result.expiresAt).toBeGreaterThanOrEqual(now + 3_600_000 - 1000);
      expect(result.expiresAt).toBeLessThanOrEqual(now + 3_600_000 + 1000);
      expect(result.refreshToken).toBe('new-refresh-token-abc');
    });

    it('returns { accessToken } when expires_in and refresh_token missing', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: 'bare-token' }),
          { status: 200 },
        ),
      );
      const result = await refreshGrokToken({
        clientId: 'cid',
        refreshToken: 'rt',
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      expect(result.accessToken).toBe('bare-token');
      expect(result.expiresAt).toBeUndefined();
      expect(result.refreshToken).toBeUndefined();
    });

    it('omits refreshToken when provider returns empty string', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 't',
            expires_in: 60,
            refresh_token: '',
          }),
          { status: 200 },
        ),
      );
      const result = await refreshGrokToken({
        clientId: 'cid',
        refreshToken: 'rt',
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      expect(result.refreshToken).toBeUndefined();
      expect(result.expiresAt).toBeDefined();
    });
  });

  describe('Request body', () => {
    it('POSTs to default endpoint with form-encoded grant_type=refresh_token', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 't' }), { status: 200 }),
      );
      await refreshGrokToken({
        clientId: 'cid-123',
        refreshToken: 'rt-xyz',
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://oauth.x.ai/token');
      expect(init.method).toBe('POST');
      const body = init.body as string;
      expect(body).toContain('grant_type=refresh_token');
      expect(body).toContain('client_id=cid-123');
      expect(body).toContain('refresh_token=rt-xyz');
    });

    it('respects custom tokenEndpoint', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 't' }), { status: 200 }),
      );
      await refreshGrokToken({
        clientId: 'cid',
        refreshToken: 'rt',
        tokenEndpoint: 'https://custom.example/token',
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      const [url] = fetchSpy.mock.calls[0] as [string];
      expect(url).toBe('https://custom.example/token');
    });
  });

  describe('HTTP errors', () => {
    it('throws GrokOAuthError with code=invalid_grant on HTTP 400', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('{"error":"invalid_grant"}', { status: 400 }),
      );
      await expect(
        refreshGrokToken({
          clientId: 'cid',
          refreshToken: 'rt',
          fetchImpl: fetchSpy as unknown as typeof fetch,
        }),
      ).rejects.toThrow(GrokOAuthError);
      try {
        await refreshGrokToken({
          clientId: 'cid',
          refreshToken: 'rt',
          fetchImpl: fetchSpy.mockResolvedValueOnce(
            new Response('{"error":"invalid_grant"}', { status: 400 }),
          ) as unknown as typeof fetch,
        });
      } catch (err) {
        expect((err as GrokOAuthError).code).toBe('invalid_grant');
      }
    });

    it('throws GrokOAuthError with code=invalid_grant on HTTP 401', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('unauthorized', { status: 401 }),
      );
      try {
        await refreshGrokToken({
          clientId: 'cid',
          refreshToken: 'rt',
          fetchImpl: fetchSpy as unknown as typeof fetch,
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GrokOAuthError);
        expect((err as GrokOAuthError).code).toBe('invalid_grant');
      }
    });

    it('throws GrokOAuthError with code=http_500 on server error', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('oops', { status: 500 }),
      );
      try {
        await refreshGrokToken({
          clientId: 'cid',
          refreshToken: 'rt',
          fetchImpl: fetchSpy as unknown as typeof fetch,
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GrokOAuthError);
        expect((err as GrokOAuthError).code).toBe('http_500');
      }
    });

    it('truncates response body in error message to 200 chars', async () => {
      const bigBody = 'x'.repeat(500);
      fetchSpy.mockResolvedValueOnce(
        new Response(bigBody, { status: 500 }),
      );
      try {
        await refreshGrokToken({
          clientId: 'cid',
          refreshToken: 'rt',
          fetchImpl: fetchSpy as unknown as typeof fetch,
        });
        expect.fail('should have thrown');
      } catch (err) {
        const msg = (err as Error).message;
        // The "HTTP 500: " prefix + first 200 chars of body.
        expect(msg.length).toBeLessThan(250);
        expect(msg).toContain('HTTP 500');
      }
    });
  });

  describe('Network errors', () => {
    it('throws GrokOAuthError on fetch rejection', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('ECONNRESET'));
      try {
        await refreshGrokToken({
          clientId: 'cid',
          refreshToken: 'rt',
          fetchImpl: fetchSpy as unknown as typeof fetch,
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GrokOAuthError);
        expect((err as Error).message).toContain('Token refresh network error');
        expect((err as Error).message).toContain('ECONNRESET');
      }
    });
  });

  describe('Response validation', () => {
    it('throws when response body is not JSON', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('<html>not json</html>', { status: 200 }),
      );
      try {
        await refreshGrokToken({
          clientId: 'cid',
          refreshToken: 'rt',
          fetchImpl: fetchSpy as unknown as typeof fetch,
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GrokOAuthError);
        expect((err as Error).message).toContain('invalid JSON');
      }
    });

    it('throws when body is not an object', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('"a string"', { status: 200 }),
      );
      try {
        await refreshGrokToken({
          clientId: 'cid',
          refreshToken: 'rt',
          fetchImpl: fetchSpy as unknown as typeof fetch,
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GrokOAuthError);
        expect((err as Error).message).toContain('non-object body');
      }
    });

    it('throws when access_token is missing', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ expires_in: 60 }), { status: 200 }),
      );
      try {
        await refreshGrokToken({
          clientId: 'cid',
          refreshToken: 'rt',
          fetchImpl: fetchSpy as unknown as typeof fetch,
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GrokOAuthError);
        expect((err as GrokOAuthError).code).toBe('no_access_token');
      }
    });

    it('throws when access_token is empty string', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: '' }), { status: 200 }),
      );
      try {
        await refreshGrokToken({
          clientId: 'cid',
          refreshToken: 'rt',
          fetchImpl: fetchSpy as unknown as typeof fetch,
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GrokOAuthError);
      }
    });
  });

  describe('Input validation', () => {
    it('throws when clientId is missing', async () => {
      try {
        await refreshGrokToken({
          clientId: '',
          refreshToken: 'rt',
          fetchImpl: fetchSpy as unknown as typeof fetch,
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as GrokOAuthError).code).toBe('no_client_id');
      }
    });

    it('throws when refreshToken is missing', async () => {
      try {
        await refreshGrokToken({
          clientId: 'cid',
          refreshToken: '',
          fetchImpl: fetchSpy as unknown as typeof fetch,
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as GrokOAuthError).code).toBe('no_refresh_token');
      }
    });
  });
});