import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  PROVIDER_ENDPOINTS,
  resolveActiveProvider,
  resolveBaseUrl,
  providerConfigFor,
} from '../../src/cli/provider/openai-compatible.js';
import { setApiKey } from '../../src/cli/keyStore.js';

describe('openai-compatible provider routing (Task 15.2)', () => {
  let testStore: string;
  let savedKeystoreEnv: string | undefined;
  let savedProviderEnv: string | undefined;
  let savedBaseUrlEnv: string | undefined;
  let savedActiveEnv: string | undefined;
  let savedModelEnv: string | undefined;

  beforeEach(() => {
    testStore = path.join(
      os.tmpdir(),
      `anathema-keys-152-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
    );
    const testProvider = path.join(
      os.tmpdir(),
      `anathema-provider-152-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
    );
    savedKeystoreEnv = process.env.ANATHEMA_KEYSTORE_FILE;
    savedProviderEnv = process.env.ANATHEMA_PROVIDER_CONFIG_FILE;
    savedBaseUrlEnv = process.env.OPENAI_BASE_URL;
    savedActiveEnv = process.env.ANATHEMA_ACTIVE_PROVIDER;
    savedModelEnv = process.env.OPENAI_MODEL;
    process.env.ANATHEMA_KEYSTORE_FILE = testStore;
    process.env.ANATHEMA_PROVIDER_CONFIG_FILE = testProvider;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.ANATHEMA_ACTIVE_PROVIDER;
    delete process.env.OPENAI_MODEL;
  });

  afterEach(async () => {
    if (savedKeystoreEnv === undefined) delete process.env.ANATHEMA_KEYSTORE_FILE;
    else process.env.ANATHEMA_KEYSTORE_FILE = savedKeystoreEnv;
    if (savedProviderEnv === undefined) delete process.env.ANATHEMA_PROVIDER_CONFIG_FILE;
    else process.env.ANATHEMA_PROVIDER_CONFIG_FILE = savedProviderEnv;
    if (savedBaseUrlEnv === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = savedBaseUrlEnv;
    if (savedActiveEnv === undefined) delete process.env.ANATHEMA_ACTIVE_PROVIDER;
    else process.env.ANATHEMA_ACTIVE_PROVIDER = savedActiveEnv;
    if (savedModelEnv === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = savedModelEnv;
    await fs.rm(testStore, { force: true });
    await fs.rm(process.env.ANATHEMA_PROVIDER_CONFIG_FILE ?? '', { force: true }).catch(() => {});
  });

  it('PROVIDER_ENDPOINTS has entries for all 5 providers', () => {
    expect(PROVIDER_ENDPOINTS['openai-compatible']).toBeDefined();
    expect(PROVIDER_ENDPOINTS.minimax).toBe('https://api.minimax.io/v1');
    expect(PROVIDER_ENDPOINTS.glm).toBe('https://api.z.ai/api/coding/paas/v4');
    expect(PROVIDER_ENDPOINTS.grok).toBe('https://api.x.ai/v1');
    expect(PROVIDER_ENDPOINTS.custom).toBeDefined();
  });

  it('resolveActiveProvider() returns openai-compatible by default', () => {
    expect(resolveActiveProvider()).toBe('openai-compatible');
  });

  it('resolveBaseUrl() returns the hardcoded endpoint for known providers', () => {
    expect(resolveBaseUrl('minimax')).toBe('https://api.minimax.io/v1');
    expect(resolveBaseUrl('glm')).toBe('https://api.z.ai/api/coding/paas/v4');
    expect(resolveBaseUrl('grok')).toBe('https://api.x.ai/v1');
  });

  it('resolveBaseUrl() respects OPENAI_BASE_URL env for openai-compatible', () => {
    process.env.OPENAI_BASE_URL = 'https://my-proxy.example.com/v1';
    expect(resolveBaseUrl('openai-compatible')).toBe('https://my-proxy.example.com/v1');
  });

  it('resolveBaseUrl() falls back to api.x.ai when no env set for openai-compatible', () => {
    expect(resolveBaseUrl('openai-compatible')).toBe('https://api.x.ai/v1');
  });

  it('providerConfigFor() returns null when key missing', async () => {
      expect(await providerConfigFor('grok')).toBeNull();
    });

    it('providerConfigFor() returns full config when key in store', async () => {
      setApiKey('grok', '***');
      const config = await providerConfigFor('grok');
      expect(config).not.toBeNull();
      expect(config?.providerId).toBe('grok');
      expect(config?.apiKey).toBe('***');
      expect(config?.baseUrl).toBe('https://api.x.ai/v1');
      expect(config?.model).toBe('grok-4');  // default model
    });

    it('providerConfigFor() respects env key override over keyStore', async () => {
      setApiKey('grok', 'sk-stored');
      process.env.GROK_API_KEY = 'sk-from-env';
      const config = await providerConfigFor('grok');
      expect(config?.apiKey).toBe('sk-from-env');
    });

    it('providerConfigFor() returns correct baseUrl for each provider', async () => {
      setApiKey('minimax', '***');
      setApiKey('glm', 'sk-glm-test');
      setApiKey('grok', 'sk-grok-test');
      expect((await providerConfigFor('minimax'))?.baseUrl).toBe('https://api.minimax.io/v1');
      expect((await providerConfigFor('glm'))?.baseUrl).toBe('https://api.z.ai/api/coding/paas/v4');
      expect((await providerConfigFor('grok'))?.baseUrl).toBe('https://api.x.ai/v1');
    });
  });