/**
 * website.test.ts — the website webhook channel (F3.3), fully offline: the
 * network is an INJECTED fetch seam (no globalThis patching), the vault an
 * injected loader. Covers the pinned HMAC signature, headers, 2xx/4xx/5xx,
 * timeout, env fallback, secret masking and the never-fabricate-url invariant.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createWebsiteChannelAdapter,
  ENV_SECRET,
  ENV_URL,
  loadWebsiteConfig,
  maskSecret,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signBody,
  validateConfig,
  WebsitePublishError,
  type WebsiteConfig,
} from './website.js';

const CONFIG: WebsiteConfig = { endpoint: 'https://hook.test/x', secret: 'test-secret' };

interface Seen {
  url?: string;
  init?: RequestInit;
}

/** Fake fetch returning `status` + JSON `body`, capturing the request. */
function fakeFetch(body: unknown, status = 200) {
  const seen: Seen = {};
  const impl = (async (url: string, init: RequestInit) => {
    seen.url = String(url);
    seen.init = init;
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

const build = (fetchImpl: typeof fetch, config: WebsiteConfig = CONFIG, timeoutMs?: number) =>
  createWebsiteChannelAdapter({ config, fetchImpl, runId: 'R1', automationId: 'a1', timeoutMs });

describe('signBody', () => {
  it('produces a deterministic pinned HMAC over the exact body', () => {
    const body = JSON.stringify({ text: 'hello world', source: 'zelari-code automation' });
    expect(signBody(body, 'test-secret')).toBe(
      'sha256=b4dbfaea1105070899238b3fec1af8b72eba5828a24a9ced54e596b391c361e1',
    );
  });
});

describe('maskSecret', () => {
  it('keeps only the first/last 4 chars of a long secret', () => {
    const masked = maskSecret('supersecretvalue');
    expect(masked).toBe('supe…alue');
    expect(masked).not.toContain('supersecretvalue');
  });

  it('fully masks a short secret', () => {
    expect(maskSecret('short')).toBe('****');
  });
});

describe('validateConfig', () => {
  it('flags a missing endpoint and secret', () => {
    const errors = validateConfig({});
    expect(errors).toContain('endpoint is required');
    expect(errors).toContain('secret is required');
  });

  it('requires an https endpoint', () => {
    expect(validateConfig({ endpoint: 'http://insecure.test', secret: 's' })[0]).toMatch(/https/);
  });

  it('accepts a valid config', () => {
    expect(validateConfig(CONFIG)).toEqual([]);
  });
});

describe('loadWebsiteConfig', () => {
  it('falls back to env when the vault is absent', async () => {
    const cfg = await loadWebsiteConfig({
      loadVaultFn: async () => null,
      env: { [ENV_URL]: 'https://env.test/hook', [ENV_SECRET]: 'envsecret' } as NodeJS.ProcessEnv,
    });
    expect(cfg.endpoint).toBe('https://env.test/hook');
    expect(cfg.secret).toBe('envsecret');
  });

  it('prefers the vault over env', async () => {
    const cfg = await loadWebsiteConfig({
      loadVaultFn: async () => ({ endpoint: 'https://vault.test/h', secret: 'vaultsec' }),
      env: { [ENV_URL]: 'https://env.test/hook' } as NodeJS.ProcessEnv,
    });
    expect(cfg.endpoint).toBe('https://vault.test/h');
  });

  it('throws a clear, actionable error when nothing is configured', async () => {
    const err = await loadWebsiteConfig({
      loadVaultFn: async () => null,
      env: {} as NodeJS.ProcessEnv,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(WebsitePublishError);
    expect(err.message).toMatch(/endpoint is required/);
    expect(err.message).toMatch(/automation credential website/);
  });
});

describe('createWebsiteChannelAdapter — publish', () => {
  it('POSTs a signed body and returns ok when the response carries a url', async () => {
    const { impl, seen } = fakeFetch({ url: 'https://blog.test/p/1', postId: 'p1' });
    const res = await build(impl).publish({ text: 'hello world' });

    expect(res.dryRun).toBe(false);
    expect(res.url).toBe('https://blog.test/p/1');
    expect(res.postId).toBe('p1');
    expect(seen.url).toBe('https://hook.test/x');
    expect(seen.init?.method).toBe('POST');
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers[SIGNATURE_HEADER]).toBe(
      signBody(String(seen.init?.body), 'test-secret'),
    );
    expect(Number(headers[TIMESTAMP_HEADER])).toBeGreaterThan(0);
    expect(String(seen.init?.body)).toContain('zelari-code automation');
  });

  it('includes media + automationId in the body when present', async () => {
    const { impl, seen } = fakeFetch({ url: 'https://blog.test/p/2' });
    await build(impl).publish({ text: 'hi', mediaPaths: ['/tmp/a.png'] });
    const body = JSON.parse(String(seen.init?.body));
    expect(body.media).toEqual(['/tmp/a.png']);
    expect(body.automationId).toBe('a1');
  });

  it('falls back to the configured pageUrl when the response omits url', async () => {
    const { impl } = fakeFetch({ postId: 'p3' });
    const res = await build(impl, { ...CONFIG, pageUrl: 'https://blog.test/landing' }).publish({
      text: 'hi',
    });
    expect(res.url).toBe('https://blog.test/landing');
    expect(res.postId).toBe('p3');
  });

  it('throws (never fabricates) when the response has no url and no pageUrl', async () => {
    const { impl } = fakeFetch({});
    const err = await build(impl)
      .publish({ text: 'hi' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(WebsitePublishError);
    expect(err.message).toMatch(/no url/);
  });

  it('throws on a 404 / 500 response', async () => {
    for (const status of [404, 500]) {
      const { impl } = fakeFetch({ error: 'nope' }, status);
      await expect(build(impl).publish({ text: 'hi' })).rejects.toThrow(new RegExp(`HTTP ${status}`));
    }
  });

  it('aborts and throws on timeout', async () => {
    const impl = ((_url: string, init: RequestInit) =>
      new Promise((_res, rej) => {
        (init.signal as AbortSignal | undefined)?.addEventListener('abort', () =>
          rej(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      })) as unknown as typeof fetch;
    await expect(build(impl, CONFIG, 10).publish({ text: 'hi' })).rejects.toThrow(/timeout/);
  });

  it('wraps a network failure into a clear error', async () => {
    const impl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(build(impl).publish({ text: 'hi' })).rejects.toThrow(/request failed: ECONNREFUSED/);
  });

  it('rejects an invalid injected config before any request', async () => {
    const impl = vi.fn() as unknown as typeof fetch;
    await expect(
      build(impl, { endpoint: 'http://insecure', secret: 's' }).publish({ text: 'hi' }),
    ).rejects.toThrow(/https/);
    expect(impl).not.toHaveBeenCalled();
  });
});
