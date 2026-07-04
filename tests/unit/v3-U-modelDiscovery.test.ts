/**
 * v3-U: modelDiscovery — auto-discover provider model lists.
 *
 * Covers:
 *   - All 4 providers (grok, glm, minimax, openai-compatible)
 *   - /v1/models endpoint mapping
 *   - Bearer auth (API key or OAuth token)
 *   - Cache write (atomic: .tmp + rename)
 *   - Cache read (sync, with isModelsCacheStale + pickDefaultModel)
 *   - Fire-and-forget variant
 *   - Error handling (network, HTTP 4xx/5xx, invalid JSON, empty response)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  discoverModelsForProvider,
  discoverModelsInBackground,
  loadModelsRegistry,
  getCachedModels,
  isModelsCacheStale,
  getDiscoveredModelIds,
  pickDefaultModel,
  ModelDiscoveryError,
  getModelsFilePath,
} from '../../src/cli/modelDiscovery.js';
import { setApiKey, setOAuthToken, clearApiKey } from '../../src/cli/keyStore.js';
import { setCustomEndpoint, clearCustomEndpoint } from '../../src/cli/providerConfig.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testFile: string;
let savedOpenAIBaseUrl: string | undefined;

beforeEach(async () => {
  testFile = path.join(os.tmpdir(), `zelari-discovery-test-${Date.now()}-${Math.random()}`, 'models.json');
  process.env.ANATHEMA_MODELS_FILE = testFile;
  process.env.ANATHEMA_KEYSTORE_FILE = path.join(path.dirname(testFile), 'keys.json');
  // Isolate providerConfig too: discovery now resolves the base URL via
  // getCustomEndpoint(), so a stray custom endpoint in the real user's
  // provider.json would pollute the URL-mapping assertions.
  process.env.ANATHEMA_PROVIDER_CONFIG_FILE = path.join(path.dirname(testFile), 'provider.json');
  // OPENAI_BASE_URL is a discovery base-URL override for openai-compatible /
  // custom — clear it so a dev/CI value doesn't leak into these tests.
  savedOpenAIBaseUrl = process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_BASE_URL;
  // Clear any leftover keys from previous tests
  clearApiKey('grok');
  clearApiKey('glm');
  clearApiKey('minimax');
  clearApiKey('openai-compatible');
});

afterEach(async () => {
  delete process.env.ANATHEMA_MODELS_FILE;
  delete process.env.ANATHEMA_KEYSTORE_FILE;
  delete process.env.ANATHEMA_PROVIDER_CONFIG_FILE;
  if (savedOpenAIBaseUrl !== undefined) process.env.OPENAI_BASE_URL = savedOpenAIBaseUrl;
  await fs.rm(path.dirname(testFile), { recursive: true, force: true }).catch(() => {});
});

function makeOpenAIMock(models: Array<{ id: string; created?: number; owned_by?: string }>, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify({
    object: 'list',
    data: models,
  }), { status, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
}

// ---------------------------------------------------------------------------
// URL mapping
// ---------------------------------------------------------------------------

describe('modelDiscovery URL mapping (v3-U)', () => {
  it('hits /v1/models on api.x.ai for grok', async () => {
    let capturedUrl: string | undefined;
    const fetchMock = (async (url: string | URL | Request) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      return makeOpenAIMock([{ id: 'grok-4-fast-reasoning' }])('x');
    }) as typeof fetch;

    await discoverModelsForProvider('grok', {
      authToken: 'test-token',
      fetchImpl: fetchMock,
    });

    expect(capturedUrl).toBe('https://api.x.ai/v1/models');
  });

  it('hits the GLM coding-plan /models endpoint for glm', async () => {
    let capturedUrl: string | undefined;
    const fetchMock = (async (url: string | URL | Request) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      return makeOpenAIMock([{ id: 'glm-4.6' }])('x');
    }) as typeof fetch;

    await discoverModelsForProvider('glm', {
      authToken: 'glm-key',
      fetchImpl: fetchMock,
    });

    expect(capturedUrl).toBe('https://api.z.ai/api/coding/paas/v4/models');
  });

  it('hits api.minimax.io/v1/models for minimax', async () => {
    let capturedUrl: string | undefined;
    const fetchMock = (async (url: string | URL | Request) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      return makeOpenAIMock([{ id: 'MiniMax-Text-01' }])('x');
    }) as typeof fetch;

    await discoverModelsForProvider('minimax', {
      authToken: 'minimax-key',
      fetchImpl: fetchMock,
    });

    expect(capturedUrl).toBe('https://api.minimax.io/v1/models');
  });

  it('hits api.x.ai/v1/models for openai-compatible (matches chat default)', async () => {
    let capturedUrl: string | undefined;
    const fetchMock = (async (url: string | URL | Request) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      return makeOpenAIMock([{ id: 'grok-4' }])('x');
    }) as typeof fetch;

    await discoverModelsForProvider('openai-compatible', {
      authToken: 'openai-key',
      fetchImpl: fetchMock,
    });

    expect(capturedUrl).toBe('https://api.x.ai/v1/models');
  });
});

// ---------------------------------------------------------------------------
// Custom endpoint resolution (regression: discovery ignored /provider custom)
// ---------------------------------------------------------------------------

describe('modelDiscovery custom endpoint (regression)', () => {
  it('uses the persisted custom endpoint over the static default', async () => {
    setCustomEndpoint('openai-compatible', 'https://forgeai.dotlabstudios.com/v1');
    let capturedUrl: string | undefined;
    const fetchMock = (async (url: string | URL | Request) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      return makeOpenAIMock([{ id: 'forge-model' }])('x');
    }) as typeof fetch;

    await discoverModelsForProvider('openai-compatible', {
      authToken: 'forge-key',
      fetchImpl: fetchMock,
    });

    expect(capturedUrl).toBe('https://forgeai.dotlabstudios.com/v1/models');
    clearCustomEndpoint('openai-compatible');
  });

  it('honors OPENAI_BASE_URL env for openai-compatible when no custom endpoint', async () => {
    process.env.OPENAI_BASE_URL = 'https://gateway.example.com/v1';
    let capturedUrl: string | undefined;
    const fetchMock = (async (url: string | URL | Request) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      return makeOpenAIMock([{ id: 'gw-model' }])('x');
    }) as typeof fetch;

    await discoverModelsForProvider('openai-compatible', {
      authToken: 'k',
      fetchImpl: fetchMock,
    });

    expect(capturedUrl).toBe('https://gateway.example.com/v1/models');
  });

  it('explicit options.baseUrl overrides a persisted custom endpoint', async () => {
    setCustomEndpoint('openai-compatible', 'https://persisted.example.com/v1');
    let capturedUrl: string | undefined;
    const fetchMock = (async (url: string | URL | Request) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      return makeOpenAIMock([{ id: 'm' }])('x');
    }) as typeof fetch;

    await discoverModelsForProvider('openai-compatible', {
      authToken: 'k',
      baseUrl: 'https://explicit.example.com/v1',
      fetchImpl: fetchMock,
    });

    expect(capturedUrl).toBe('https://explicit.example.com/v1/models');
    clearCustomEndpoint('openai-compatible');
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('modelDiscovery auth (v3-U)', () => {
  it('sends Authorization: Bearer header with explicit authToken', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return makeOpenAIMock([{ id: 'm1' }])('x');
    }) as typeof fetch;

    await discoverModelsForProvider('grok', {
      authToken: 'explicit-token',
      fetchImpl: fetchMock,
    });

    expect(capturedHeaders?.Authorization).toBe('Bearer explicit-token');
  });

  it('uses OAuth token for grok when no explicit authToken', async () => {
    setOAuthToken('grok', { apiKey: 'oauth-access-token', expiresAt: Date.now() + 3600_000 });
    let capturedHeaders: Record<string, string> | undefined;
    const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return makeOpenAIMock([{ id: 'grok-4' }])('x');
    }) as typeof fetch;

    await discoverModelsForProvider('grok', { fetchImpl: fetchMock });

    expect(capturedHeaders?.Authorization).toBe('Bearer oauth-access-token');
  });

  it('uses API key from keyStore for non-grok providers when no explicit authToken', async () => {
    setApiKey('glm', 'glm-key-from-store');
    let capturedHeaders: Record<string, string> | undefined;
    const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return makeOpenAIMock([{ id: 'glm-4.6' }])('x');
    }) as typeof fetch;

    await discoverModelsForProvider('glm', { fetchImpl: fetchMock });

    expect(capturedHeaders?.Authorization).toBe('Bearer glm-key-from-store');
  });

  it('omits Authorization header when no auth available', async () => {
    // Save and clear all env-based auth sources so this test is hermetic
    // (otherwise CI/dev environments with OPENAI_API_KEY set will see a Bearer header).
    const savedEnv: Record<string, string | undefined> = {};
    for (const k of ['OPENAI_API_KEY', 'ANATHEMA_API_KEY', 'GROK_API_KEY', 'GLM_API_KEY', 'MINIMAX_API_KEY']) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    // Also wipe the keyStore so resolveApiKeyWithMeta returns null
    clearApiKey('openai-compatible');
    let capturedHeaders: Record<string, string> | undefined;
    const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return makeOpenAIMock([{ id: 'm1' }])('x');
    }) as typeof fetch;
    try {
      await discoverModelsForProvider('openai-compatible', { fetchImpl: fetchMock });
      expect(capturedHeaders?.Authorization).toBeUndefined();
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v !== undefined) process.env[k] = v;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

describe('modelDiscovery response parsing (v3-U)', () => {
  it('parses OpenAI-compat response and sorts by id', async () => {
    const fetchMock = makeOpenAIMock([
      { id: 'grok-4', created: 1234567890, owned_by: 'xai' },
      { id: 'grok-3', created: 1000000000, owned_by: 'xai' },
      { id: 'grok-4-fast', created: 1200000000, owned_by: 'xai' },
    ]);
    const entry = await discoverModelsForProvider('grok', {
      authToken: 't',
      fetchImpl: fetchMock,
    });
    expect(entry.models.map((m) => m.id)).toEqual(['grok-3', 'grok-4', 'grok-4-fast']);
    expect(entry.models[0]?.created).toBe(1000000000);
    expect(entry.models[0]?.ownedBy).toBe('xai');
  });

  it('skips entries with missing or non-string id', async () => {
    const fetchMock = (async () => new Response(JSON.stringify({
      object: 'list',
      data: [
        { id: 'valid-1' },
        { id: 42 }, // not a string → skip
        { },       // missing id → skip
        { id: 'valid-2' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    const entry = await discoverModelsForProvider('grok', {
      authToken: 't',
      fetchImpl: fetchMock,
    });
    expect(entry.models.map((m) => m.id)).toEqual(['valid-1', 'valid-2']);
  });

  it('rejects empty response (refuses to overwrite cache)', async () => {
    const fetchMock = makeOpenAIMock([]);
    await expect(
      discoverModelsForProvider('grok', { authToken: 't', fetchImpl: fetchMock })
    ).rejects.toBeInstanceOf(ModelDiscoveryError);
  });

  it('throws on invalid JSON', async () => {
    const fetchMock = (async () => new Response('not-json', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
    await expect(
      discoverModelsForProvider('grok', { authToken: 't', fetchImpl: fetchMock })
    ).rejects.toBeInstanceOf(ModelDiscoveryError);
  });
});

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

describe('modelDiscovery cache (v3-U)', () => {
  it('persists results to disk atomically', async () => {
    const fetchMock = makeOpenAIMock([{ id: 'glm-4.6' }]);
    const entry = await discoverModelsForProvider('glm', {
      authToken: 't',
      fetchImpl: fetchMock,
    });
    expect(entry.fetchedAt).toBeGreaterThan(0);
    // File exists
    const onDisk = loadModelsRegistry(testFile);
    expect(onDisk.glm?.models[0]?.id).toBe('glm-4.6');
    expect(onDisk.glm?.fetchedAt).toBe(entry.fetchedAt);
  });

  it('getCachedModels returns undefined for unknown provider', () => {
    expect(getCachedModels('grok', testFile)).toBeUndefined();
  });

  it('getCachedModels returns the entry after discovery', async () => {
    const fetchMock = makeOpenAIMock([{ id: 'glm-4.6' }]);
    await discoverModelsForProvider('glm', { authToken: 't', fetchImpl: fetchMock });
    const entry = getCachedModels('glm', testFile);
    expect(entry?.models[0]?.id).toBe('glm-4.6');
  });

  it('skipCacheWrite=true does not touch the file', async () => {
    const fetchMock = makeOpenAIMock([{ id: 'm1' }]);
    await discoverModelsForProvider('grok', { authToken: 't', fetchImpl: fetchMock, skipCacheWrite: true });
    expect(getCachedModels('grok', testFile)).toBeUndefined();
  });

  it('isModelsCacheStale returns true when no cache', () => {
    expect(isModelsCacheStale('grok', 6 * 60 * 60 * 1000, testFile)).toBe(true);
  });

  it('isModelsCacheStale returns false for fresh cache', async () => {
    const fetchMock = makeOpenAIMock([{ id: 'm1' }]);
    await discoverModelsForProvider('grok', { authToken: 't', fetchImpl: fetchMock });
    expect(isModelsCacheStale('grok', 6 * 60 * 60 * 1000, testFile)).toBe(false);
  });

  it('isModelsCacheStale returns true for old cache', async () => {
    const fetchMock = makeOpenAIMock([{ id: 'm1' }]);
    await discoverModelsForProvider('grok', { authToken: 't', fetchImpl: fetchMock });
    // Pretend 7h passed
    const sevenHoursLater = Date.now() + 7 * 60 * 60 * 1000;
    expect(isModelsCacheStale('grok', 6 * 60 * 60 * 1000, testFile, sevenHoursLater)).toBe(true);
  });

  it('survives concurrent discoveries for different providers', async () => {
    const grokMock = makeOpenAIMock([{ id: 'grok-4' }]);
    const glmMock = makeOpenAIMock([{ id: 'glm-4.6' }]);
    await Promise.all([
      discoverModelsForProvider('grok', { authToken: 't', fetchImpl: grokMock }),
      discoverModelsForProvider('glm', { authToken: 't', fetchImpl: glmMock }),
    ]);
    const onDisk = loadModelsRegistry(testFile);
    expect(onDisk.grok?.models[0]?.id).toBe('grok-4');
    expect(onDisk.glm?.models[0]?.id).toBe('glm-4.6');
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('modelDiscovery error handling (v3-U)', () => {
  it('throws ModelDiscoveryError on network error', async () => {
    const fetchMock = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    await expect(
      discoverModelsForProvider('grok', { authToken: 't', fetchImpl: fetchMock })
    ).rejects.toMatchObject({ code: 'network_error' });
  });

  it('throws ModelDiscoveryError on HTTP 401', async () => {
    const fetchMock = (async () => new Response('Unauthorized', { status: 401 })) as typeof fetch;
    await expect(
      discoverModelsForProvider('grok', { authToken: 'bad', fetchImpl: fetchMock })
    ).rejects.toMatchObject({ code: 'http_401' });
  });

  it('throws ModelDiscoveryError on HTTP 500', async () => {
    const fetchMock = (async () => new Response('Server Error', { status: 500 })) as typeof fetch;
    await expect(
      discoverModelsForProvider('grok', { authToken: 't', fetchImpl: fetchMock })
    ).rejects.toMatchObject({ code: 'http_500' });
  });
});

// ---------------------------------------------------------------------------
// Fire-and-forget
// ---------------------------------------------------------------------------

describe('discoverModelsInBackground (v3-U)', () => {
  it('does not throw on failure (calls onError instead)', async () => {
    const fetchMock = (async () => {
      throw new Error('boom');
    }) as typeof fetch;
    const onError = vi.fn();
    // Should NOT throw
    expect(() =>
      discoverModelsInBackground('grok', { authToken: 't', fetchImpl: fetchMock, onError })
    ).not.toThrow();
    // Give the microtask queue a tick
    await new Promise((r) => setTimeout(r, 50));
    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(ModelDiscoveryError);
  });

  it('writes to cache on success', async () => {
    const fetchMock = makeOpenAIMock([{ id: 'grok-4' }]);
    discoverModelsInBackground('grok', { authToken: 't', fetchImpl: fetchMock });
    await new Promise((r) => setTimeout(r, 100));
    expect(getCachedModels('grok', testFile)?.models[0]?.id).toBe('grok-4');
  });
});

// ---------------------------------------------------------------------------
// Suggestion helpers
// ---------------------------------------------------------------------------

describe('getDiscoveredModelIds + pickDefaultModel (v3-U)', () => {
  it('returns undefined when no cache', () => {
    expect(getDiscoveredModelIds('grok', testFile)).toBeUndefined();
  });

  it('returns sorted ids when cache exists', async () => {
    const fetchMock = makeOpenAIMock([{ id: 'b-model' }, { id: 'a-model' }]);
    await discoverModelsForProvider('grok', { authToken: 't', fetchImpl: fetchMock });
    expect(getDiscoveredModelIds('grok', testFile)).toEqual(['a-model', 'b-model']);
  });

  it('pickDefaultModel prefers "latest" / "chat" id from cache', async () => {
    const fetchMock = makeOpenAIMock([
      { id: 'grok-3' },
      { id: 'grok-4-latest' },
      { id: 'grok-4-fast' },
    ]);
    await discoverModelsForProvider('grok', { authToken: 't', fetchImpl: fetchMock });
    const picked = pickDefaultModel('grok', {}, testFile);
    expect(picked).toBe('grok-4-latest');
  });

  it('pickDefaultModel falls back to providerDefaults when no cache', () => {
    const picked = pickDefaultModel('grok', { grok: 'grok-4' }, testFile);
    expect(picked).toBe('grok-4');
  });

  it('pickDefaultModel returns undefined when no cache and no default', () => {
    const picked = pickDefaultModel('grok', {}, testFile);
    expect(picked).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// File path
// ---------------------------------------------------------------------------

describe('getModelsFilePath (v3-U)', () => {
  it('respects ANATHEMA_MODELS_FILE env var', () => {
    expect(getModelsFilePath()).toBe(testFile);
  });
});