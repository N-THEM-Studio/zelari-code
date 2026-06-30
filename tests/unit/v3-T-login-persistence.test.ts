/**
 * v3-T smoke test — verifies /login glm persistence flow.
 *
 * Simulates:
 *   1. /login glm fake-key-here
 *   2. /model glm-4.6
 *   3. (no prompt — but providerFromEnv should resolve)
 *
 * Asserts:
 *   - setApiKey stores the key in keyStore file
 *   - persistActiveProvider switches to 'glm'
 *   - getModelForProvider returns the model set via /model
 *   - providerFromEnv returns a valid config (apiKey from keyStore)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import {
  setApiKey,
  resolveApiKeyWithMeta,
} from '../../src/cli/keyStore.js';
import {
  setActiveProviderId,
  getProviderConfig,
  getModelForProvider,
  setModelForProvider,
} from '../../src/cli/providerConfig.js';
import { providerFromEnv } from '../../src/cli/provider/openai-compatible.js';

describe('v3-T: /login glm persistence', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.ANATHEMA_KEYSTORE_FILE = path.join(os.tmpdir(), `zelari-test-${Date.now()}-${Math.random()}`, 'keys.json');
    process.env.ANATHEMA_PROVIDER_CONFIG_FILE = path.join(os.tmpdir(), `zelari-test-${Date.now()}-${Math.random()}`, 'provider-config.json');
    delete process.env.GLM_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should persist /login glm <key> + switch active provider', async () => {
    // Step 1: simulate /login glm fake-key-here
    setApiKey('glm', 'fake-key-here');

    // Step 2: simulate /model glm-4.6
    setModelForProvider('glm', 'glm-4.6');

    // Step 3: simulate the persistActiveProvider('glm') call from app.tsx
    setActiveProviderId('glm');

    // Verify the key is stored
    const resolved = await resolveApiKeyWithMeta('glm');
    expect(resolved).not.toBeNull();
    expect(resolved?.apiKey).toBe('fake-key-here');

    // Verify the active provider switched
    expect(getProviderConfig().activeProviderId).toBe('glm');

    // Verify the model is set
    expect(getModelForProvider('glm')).toBe('glm-4.6');

    // Verify providerFromEnv returns a valid config (the bug fix!)
    const envConfig = await providerFromEnv();
    expect(envConfig).not.toBeNull();
    expect(envConfig?.apiKey).toBe('fake-key-here');
    expect(envConfig?.providerId).toBe('glm');
    expect(envConfig?.model).toBe('glm-4.6');
  });

  it('should not regress openai-compatible when env var is set', async () => {
    process.env.OPENAI_API_KEY = 'env-key';
    // No /login called — should still work via env var
    const envConfig = await providerFromEnv();
    expect(envConfig).not.toBeNull();
    expect(envConfig?.apiKey).toBe('env-key');
    expect(envConfig?.providerId).toBe('openai-compatible');
  });
});