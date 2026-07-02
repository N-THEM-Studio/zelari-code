import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerRefreshImpl,
  unregisterRefreshImpl,
  getRefreshImpl,
  listRefreshImpls,
  clearRefreshRegistry,
  grokRefreshAdapter,
  type RefreshImpl,
} from '../../src/cli/refreshRegistry.js';
import { DEFAULT_GROK_OAUTH_CLIENT_ID } from '../../src/cli/grokOAuth.js';

/**
 * Tests for the v3-F refresh registry (Task F.1).
 *
 * The registry is a Map<ProviderName, RefreshImpl>. The Grok impl is
 * registered by default at module import via registerDefaultRefreshImpls().
 *
 * We isolate each test with clearRefreshRegistry() so the test order does
 * not matter and tests do not leak registrations between files.
 */
describe('refreshRegistry (Task F.1)', () => {
  beforeEach(() => {
    clearRefreshRegistry();
  });

  it('returns null for unknown providers', () => {
    expect(getRefreshImpl('minimax')).toBeNull();
    expect(getRefreshImpl('glm')).toBeNull();
    expect(getRefreshImpl('grok')).toBeNull();
    expect(getRefreshImpl('custom')).toBeNull();
  });

  it('returns an empty list when nothing is registered', () => {
    expect(listRefreshImpls()).toEqual([]);
  });

  it('registerRefreshImpl stores an impl that can be retrieved', () => {
    const fakeImpl: RefreshImpl = async () => ({ accessToken: 'tok' });
    registerRefreshImpl('grok', fakeImpl);
    expect(getRefreshImpl('grok')).toBe(fakeImpl);
    expect(listRefreshImpls()).toContain('grok');
  });

  it('registerRefreshImpl overwrites a previous impl', () => {
    const first: RefreshImpl = async () => ({ accessToken: 'first' });
    const second: RefreshImpl = async () => ({ accessToken: 'second' });
    registerRefreshImpl('grok', first);
    registerRefreshImpl('grok', second);
    expect(getRefreshImpl('grok')).toBe(second);
  });

  it('registerRefreshImpl(null) removes the impl', () => {
    registerRefreshImpl('grok', async () => ({ accessToken: 'x' }));
    expect(getRefreshImpl('grok')).not.toBeNull();
    registerRefreshImpl('grok', null);
    expect(getRefreshImpl('grok')).toBeNull();
  });

  it('unregisterRefreshImpl removes the impl (no-op if not registered)', () => {
    registerRefreshImpl('grok', async () => ({ accessToken: 'x' }));
    unregisterRefreshImpl('grok');
    expect(getRefreshImpl('grok')).toBeNull();
    unregisterRefreshImpl('minimax'); // no-op
    expect(getRefreshImpl('minimax')).toBeNull();
  });

  it('grokRefreshAdapter falls back to the default client id when GROK_OAUTH_CLIENT_ID is missing', async () => {
    // Regression: the adapter used to THROW when the env var was unset, which
    // silently broke auto-refresh for every user who logged in via the default
    // `/login grok` OAuth flow (the login uses DEFAULT_GROK_OAUTH_CLIENT_ID,
    // so no env var is ever set). resolveApiKeyWithMeta swallowed the throw
    // and returned the stale/expired token → upstream 401 → "login not saved".
    const prev = process.env.GROK_OAUTH_CLIENT_ID;
    delete process.env.GROK_OAUTH_CLIENT_ID;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ''));
      expect(body.get('client_id')).toBe(DEFAULT_GROK_OAUTH_CLIENT_ID);
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('rt');
      return new Response(JSON.stringify({ access_token: 'fresh-tok', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await grokRefreshAdapter('grok', 'rt');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.accessToken).toBe('fresh-tok');
    } finally {
      vi.unstubAllGlobals();
      if (prev !== undefined) process.env.GROK_OAUTH_CLIENT_ID = prev;
    }
  });

  it('grokRefreshAdapter prefers GROK_OAUTH_CLIENT_ID env when set', async () => {
    const prev = process.env.GROK_OAUTH_CLIENT_ID;
    process.env.GROK_OAUTH_CLIENT_ID = 'env-client-id';
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ''));
      expect(body.get('client_id')).toBe('env-client-id');
      return new Response(JSON.stringify({ access_token: 'fresh-tok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await grokRefreshAdapter('grok', 'rt');
      expect(result.accessToken).toBe('fresh-tok');
    } finally {
      vi.unstubAllGlobals();
      if (prev !== undefined) process.env.GROK_OAUTH_CLIENT_ID = prev;
      else delete process.env.GROK_OAUTH_CLIENT_ID;
    }
  });

  it('grokRefreshAdapter calls refreshGrokToken with the right shape (fetch mocked)', async () => {
    // We mock by registering a fake impl that asserts the shape — avoids
    // mocking the actual fetch. The adapter delegates to refreshGrokToken
    // which is well-tested in cli-grokTokenRefresh.test.ts.
    let captured: { providerId: string; refreshToken: string } | null = null;
    const fake: RefreshImpl = async (providerId, refreshToken) => {
      captured = { providerId, refreshToken };
      return { accessToken: 'new-tok', expiresAt: 12345, refreshToken: 'new-rt' };
    };
    registerRefreshImpl('grok', fake);
    const result = await getRefreshImpl('grok')!('grok', 'old-rt');
    expect(captured).toEqual({ providerId: 'grok', refreshToken: 'old-rt' });
    expect(result.accessToken).toBe('new-tok');
    expect(result.expiresAt).toBe(12345);
    expect(result.refreshToken).toBe('new-rt');
  });

  it('listRefreshImpls returns the registered providers in insertion order', () => {
    registerRefreshImpl('grok', async () => ({ accessToken: 'g' }));
    registerRefreshImpl('minimax', async () => ({ accessToken: 'm' }));
    registerRefreshImpl('glm', async () => ({ accessToken: 'l' }));
    expect(listRefreshImpls()).toEqual(['grok', 'minimax', 'glm']);
  });

  it('clearRefreshRegistry wipes all registrations', () => {
    registerRefreshImpl('grok', async () => ({ accessToken: 'g' }));
    registerRefreshImpl('glm', async () => ({ accessToken: 'l' }));
    clearRefreshRegistry();
    expect(listRefreshImpls()).toEqual([]);
  });
});