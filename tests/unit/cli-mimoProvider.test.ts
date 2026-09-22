import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PROVIDERS, getProviderSpec, looksLikeApiKey } from '../../src/cli/keyStore.js';
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
import { getStaticFallbackModels } from '../../src/cli/modelDiscovery.js';

/**
 * Xiaomi MiMo "Token Plan" provider wiring.
 *
 * Verifies the provider is registered end-to-end: keyStore spec (Token Plan
 * base URL + MIMO_API_KEY + tp-/ttp- key prefixes), default model, chat and
 * discovery endpoints agreeing on the same host, and the seeded static
 * fallback — so `/provider mimo` + `/login mimo <tp-key>` work before
 * discovery runs.
 *
 * Pricing: Token Plan is a fixed subscription; no per-token list price is
 * invented — getModelRate must fall back to the documented DEFAULT_RATE.
 */
describe('mimo provider', () => {
  let testFile: string;
  let savedEnvFile: string | undefined;
  let savedEnvActive: string | undefined;
  let savedEnvModel: string | undefined;

  beforeEach(() => {
    testFile = path.join(
      os.tmpdir(),
      `anathema-mimo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
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

  it('is registered in PROVIDERS with the Token Plan base URL + env var', () => {
    const spec = getProviderSpec('mimo');
    expect(spec).toBeDefined();
    expect(spec?.displayName).toBe('Xiaomi MiMo (Token Plan)');
    expect(spec?.envVar).toBe('MIMO_API_KEY');
    expect(spec?.baseUrl).toBe('https://token-plan-ams.xiaomimimo.com/v1');
    expect(PROVIDERS.some((p) => p.id === 'mimo')).toBe(true);
  });

  it('accepts Token Plan key prefixes (tp- individual, ttp- team)', () => {
    expect(looksLikeApiKey('tp-abc123')).toBe(true);
    expect(looksLikeApiKey('ttp-abc123')).toBe(true);
    // Existing prefixes keep working, paste-codes keep being rejected.
    expect(looksLikeApiKey('sk-keep')).toBe(true);
    expect(looksLikeApiKey('random-oauth-paste-code')).toBe(false);
  });

  it('defaults to mimo-v2.6-pro before discovery runs', () => {
    expect(getProviderConfig().modelByProvider.mimo).toBe('mimo-v2.6-pro');
    setActiveProviderId('mimo');
    expect(getModelForProvider('mimo')).toBe('mimo-v2.6-pro');
  });

  it('resolves chat + discovery to the same Token Plan host', () => {
    expect(PROVIDER_ENDPOINTS.mimo).toBe('https://token-plan-ams.xiaomimimo.com/v1');
    expect(resolveBaseUrl('mimo')).toBe('https://token-plan-ams.xiaomimimo.com/v1');
  });

  it('seeds mimo-v2.6-pro as the static fallback (discovery fills the rest)', () => {
    const fallback = getStaticFallbackModels('mimo');
    expect(fallback.some((m) => m.id === 'mimo-v2.6-pro')).toBe(true);
  });

  it('falls back to the default rate (fixed subscription — no invented per-token price)', () => {
    const rate = getModelRate('mimo-v2.6-pro');
    expect(Number.isFinite(rate.input)).toBe(true);
    expect(Number.isFinite(rate.output)).toBe(true);
    expect(rate.input).toBeGreaterThan(0);
    expect(rate.output).toBeGreaterThan(0);
  });
});
