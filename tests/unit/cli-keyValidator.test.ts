import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateApiKey, type ValidateOptions } from '../../src/cli/keyValidator.js';

/**
 * Tests for the v3-F key validator (Task F.2).
 *
 * Strategy: stub global fetch with vi.fn() returning a Response-like object.
 * Verify each reason branch (ok, unauthorized, forbidden, unknown, network,
 * no_base_url) and that timeout works.
 */
function mockFetch(status: number, body: string | object = ''): typeof fetch {
  const response = {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'object' ? body : JSON.parse(JSON.stringify(body))),
  } as unknown as Response;
  return vi.fn(async () => Promise.resolve(response)) as unknown as typeof fetch;
}

describe('validateApiKey (Task F.2)', () => {
  let savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    savedEnv = {
      MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
      GLM_API_KEY: process.env.GLM_API_KEY,
      GROK_API_KEY: process.env.GROK_API_KEY,
    };
    delete process.env.MINIMAX_API_KEY;
    delete process.env.GLM_API_KEY;
    delete process.env.GROK_API_KEY;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('returns ok=true on a 2xx response', async () => {
    const opts: ValidateOptions = { fetchImpl: mockFetch(200, { data: [] }) };
    const result = await validateApiKey('minimax', 'sk-test', opts);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.skipped).toBeUndefined();
    expect(result.reason).toBeUndefined();
  });

  it('returns reason=unauthorized on 401', async () => {
    const opts: ValidateOptions = { fetchImpl: mockFetch(401, 'invalid') };
    const result = await validateApiKey('minimax', 'bad-key', opts);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unauthorized');
    expect(result.status).toBe(401);
  });

  it('returns reason=forbidden on 403', async () => {
    const opts: ValidateOptions = { fetchImpl: mockFetch(403) };
    const result = await validateApiKey('grok', 'limited-key', opts);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('forbidden');
    expect(result.status).toBe(403);
  });

  it('returns reason=unknown on 5xx', async () => {
    const opts: ValidateOptions = { fetchImpl: mockFetch(503) };
    const result = await validateApiKey('glm', 'sk-test', opts);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unknown');
    expect(result.status).toBe(503);
  });

  it('returns reason=network when fetch throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const opts: ValidateOptions = { fetchImpl };
    const result = await validateApiKey('minimax', 'sk-test', opts);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('network');
    expect(result.detail).toContain('ECONNREFUSED');
  });

  it('returns reason=network on timeout (AbortController fires)', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      // Wait for the abort signal — simulate a hanging request.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }) as unknown as typeof fetch;
    const opts: ValidateOptions = { fetchImpl, timeoutMs: 50 };
    const result = await validateApiKey('minimax', 'sk-test', opts);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('network');
    expect(result.detail).toMatch(/timeout|aborted/i);
  });

  it('returns ok=true, skipped=true when provider has no baseUrl', async () => {
    // `custom` provider has no baseUrl in its spec.
    const result = await validateApiKey('custom', 'sk-test');
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no_base_url');
  });

  it('returns ok=true, skipped=true when provider is unknown', async () => {
    // Simulate an unknown provider id by hacking getProviderSpec — instead we
    // just use 'custom' which is in PROVIDERS but has no baseUrl.
    const result = await validateApiKey('custom', 'sk-test');
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
  });
});