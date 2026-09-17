/**
 * oneShot.test.ts — resolveLlm defaulting + chatCompletion (offline).
 *
 * The provider/key/base-url utilities are mocked so the test never reads a real
 * config file or hits the network. `fetch` is stubbed per case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  provider: 'glm',
  modelByProvider: { glm: 'glm-4.6' } as Record<string, string>,
  key: 'test-key' as string | null,
  baseUrl: 'https://glm.test/v1',
}));

vi.mock('../providerConfig.js', () => ({
  getProviderConfig: () => ({ activeProviderId: mocks.provider }),
  getModelForProvider: (id: string) => mocks.modelByProvider[id] ?? '',
}));
vi.mock('../keyStore.js', () => ({
  resolveApiKeyWithMeta: async () => (mocks.key === null ? null : { apiKey: mocks.key }),
}));
vi.mock('../provider/openai-compatible.js', () => ({
  resolveBaseUrl: () => mocks.baseUrl,
}));

import { chatCompletion, resolveLlm } from './oneShot.js';

beforeEach(() => {
  mocks.provider = 'glm';
  mocks.modelByProvider = { glm: 'glm-4.6' };
  mocks.key = 'test-key';
  mocks.baseUrl = 'https://glm.test/v1';
  delete process.env.ZELARI_MODEL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.ZELARI_MODEL;
});

describe('resolveLlm', () => {
  it('uses the active provider + per-provider model by default', async () => {
    const llm = await resolveLlm({});
    expect(llm).toEqual({
      provider: 'glm',
      model: 'glm-4.6',
      apiKey: 'test-key',
      baseUrl: 'https://glm.test/v1',
    });
  });

  it('honors an explicit provider + model override', async () => {
    const llm = await resolveLlm({ provider: 'glm', model: 'glm-5.3' });
    expect(llm.model).toBe('glm-5.3');
    expect(llm.provider).toBe('glm');
  });

  it('falls back to ZELARI_MODEL when no per-provider model is set', async () => {
    mocks.modelByProvider = { glm: '' };
    process.env.ZELARI_MODEL = 'env-model';
    const llm = await resolveLlm({});
    expect(llm.model).toBe('env-model');
  });

  it('throws a clear error when no model can be resolved', async () => {
    mocks.modelByProvider = { glm: '' };
    await expect(resolveLlm({})).rejects.toThrow(/No model selected for provider 'glm'/);
  });

  it('throws a clear error when the API key is missing', async () => {
    mocks.key = null;
    await expect(resolveLlm({})).rejects.toThrow(/No API key for provider 'glm'/);
  });

  it('throws a clear error when the base URL is missing', async () => {
    mocks.baseUrl = '';
    await expect(resolveLlm({})).rejects.toThrow(/No base URL for provider 'glm'/);
  });
});

describe('chatCompletion', () => {
  const llm = { provider: 'glm', model: 'glm-4.6', apiKey: 'k', baseUrl: 'https://glm.test/v1' };

  it('POSTs to /chat/completions with bearer auth and returns text + usage', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '  hello post  ' } }],
        usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await chatCompletion(llm, { system: 'S', user: 'U' });
    expect(res.text).toBe('hello post');
    expect(res.usage).toEqual({ promptTokens: 3, completionTokens: 5, totalTokens: 8 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://glm.test/v1/chat/completions');
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe('Bearer k');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.stream).toBe(false);
    expect(body.model).toBe('glm-4.6');
    expect(body.messages).toEqual([
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' },
    ]);
  });

  it('returns undefined usage when the provider omits it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    })));
    expect((await chatCompletion(llm, { system: 'S', user: 'U' })).usage).toBeUndefined();
  });

  it('throws with status + body slice on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'boom',
    })));
    await expect(chatCompletion(llm, { system: 'S', user: 'U' })).rejects.toThrow(
      /LLM HTTP 500: boom/,
    );
  });

  it('throws "Empty model response" when content is blank', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '   ' } }] }),
    })));
    await expect(chatCompletion(llm, { system: 'S', user: 'U' })).rejects.toThrow(
      /Empty model response/,
    );
  });
});
