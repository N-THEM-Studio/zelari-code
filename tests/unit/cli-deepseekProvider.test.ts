import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PROVIDERS, getProviderSpec } from '../../src/cli/keyStore.js';
import {
  getProviderConfig,
  getModelForProvider,
  setActiveProviderId,
} from '../../src/cli/providerConfig.js';
import {
  PROVIDER_ENDPOINTS,
  resolveBaseUrl,
} from '../../src/cli/provider/openai-compatible.js';
import { getModelRate } from '../../src/cli/modelPricing.js';

/**
 * DeepSeek "global" provider wiring (v1.0.x).
 *
 * Verifies the provider is registered end-to-end: keyStore spec, default
 * model, chat endpoint, and pricing — so `/provider deepseek` + `/model`
 * discovery resolve against `https://api.deepseek.com` and default to
 * deepseek-v4-pro before discovery runs.
 */
describe('deepseek provider', () => {
  let testFile: string;
  let savedEnvFile: string | undefined;
  let savedEnvActive: string | undefined;
  let savedEnvModel: string | undefined;

  beforeEach(() => {
    testFile = path.join(
      os.tmpdir(),
      `anathema-deepseek-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
    );
    savedEnvFile = process.env.ANATHEMA_PROVIDER_CONFIG_FILE;
    savedEnvActive = process.env.ANATHEMA_ACTIVE_PROVIDER;
    savedEnvModel = process.env.OPENAI_MODEL;
    process.env.ANATHEMA_PROVIDER_CONFIG_FILE = testFile;
    delete process.env.ANATHEMA_ACTIVE_PROVIDER;
    delete process.env.OPENAI_MODEL;
  });

  afterEach(async () => {
    if (savedEnvFile === undefined) delete process.env.ANATHEMA_PROVIDER_CONFIG_FILE;
    else process.env.ANATHEMA_PROVIDER_CONFIG_FILE = savedEnvFile;
    if (savedEnvActive === undefined) delete process.env.ANATHEMA_ACTIVE_PROVIDER;
    else process.env.ANATHEMA_ACTIVE_PROVIDER = savedEnvActive;
    if (savedEnvModel === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = savedEnvModel;
    await fs.rm(testFile, { force: true });
  });

  it('is registered in PROVIDERS with the global base URL + env var', () => {
    const spec = getProviderSpec('deepseek');
    expect(spec).toBeDefined();
    expect(spec?.displayName).toBe('DeepSeek');
    expect(spec?.envVar).toBe('DEEPSEEK_API_KEY');
    expect(spec?.baseUrl).toBe('https://api.deepseek.com');
    expect(PROVIDERS.some((p) => p.id === 'deepseek')).toBe(true);
  });

  it('defaults to deepseek-v4-pro before discovery runs', () => {
    expect(getProviderConfig().modelByProvider.deepseek).toBe('deepseek-v4-pro');
    setActiveProviderId('deepseek');
    expect(getModelForProvider('deepseek')).toBe('deepseek-v4-pro');
  });

  it('resolves chat + discovery to the same DeepSeek host', () => {
    expect(PROVIDER_ENDPOINTS.deepseek).toBe('https://api.deepseek.com');
    expect(resolveBaseUrl('deepseek')).toBe('https://api.deepseek.com');
  });

  it('prices both discovered models (flash cheaper than pro)', () => {
    const flash = getModelRate('deepseek-v4-flash');
    const pro = getModelRate('deepseek-v4-pro');
    expect(flash.input).toBeLessThan(pro.input);
    expect(flash.output).toBeLessThan(pro.output);
  });
});
