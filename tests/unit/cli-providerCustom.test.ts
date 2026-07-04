import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getProviderConfig,
  setCustomEndpoint,
  getCustomEndpoint,
  clearCustomEndpoint,
  loadProviderConfig,
} from '../../src/cli/providerConfig.js';
import { resolveBaseUrl } from '../../src/cli/provider/openai-compatible.js';
import { handleSlashCommand } from '../../src/cli/slashCommands.js';

/**
 * Task A3: custom base URL per provider.
 *
 * Covers:
 *   - providerConfig.setCustomEndpoint / getCustomEndpoint / clearCustomEndpoint
 *   - URL validation (empty / malformed)
 *   - Round-trip persistence (sync + async load)
 *   - resolveBaseUrl priority: custom endpoint > env > default
 *   - Slash command /provider custom <baseUrl> and /provider custom clear
 */
describe('Task A3 — custom base URLs per provider', () => {
  let testFile: string;
  let savedEnvFile: string | undefined;
  let savedEnvOpenAiBaseUrl: string | undefined;

  beforeEach(() => {
    testFile = path.join(
      os.tmpdir(),
      `anathema-custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
    );
    savedEnvFile = process.env.ANATHEMA_PROVIDER_CONFIG_FILE;
    savedEnvOpenAiBaseUrl = process.env.OPENAI_BASE_URL;
    process.env.ANATHEMA_PROVIDER_CONFIG_FILE = testFile;
    delete process.env.OPENAI_BASE_URL;
  });

  afterEach(async () => {
    if (savedEnvFile === undefined) delete process.env.ANATHEMA_PROVIDER_CONFIG_FILE;
    else process.env.ANATHEMA_PROVIDER_CONFIG_FILE = savedEnvFile;
    if (savedEnvOpenAiBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = savedEnvOpenAiBaseUrl;
    await fs.rm(testFile, { force: true });
  });

  describe('providerConfig customEndpoints helpers', () => {
    it('setCustomEndpoint + getCustomEndpoint round-trip', () => {
      setCustomEndpoint('openai-compatible', 'http://localhost:11434/v1');
      expect(getCustomEndpoint('openai-compatible')).toBe('http://localhost:11434/v1');
    });

    it('getCustomEndpoint returns undefined for unset provider', () => {
      expect(getCustomEndpoint('grok')).toBeUndefined();
    });

    it('clearCustomEndpoint removes the override', () => {
      setCustomEndpoint('openai-compatible', 'http://localhost:11434/v1');
      clearCustomEndpoint('openai-compatible');
      expect(getCustomEndpoint('openai-compatible')).toBeUndefined();
    });

    it('clearCustomEndpoint is a no-op when nothing is set', () => {
      // Should not throw.
      clearCustomEndpoint('grok');
      expect(getCustomEndpoint('grok')).toBeUndefined();
    });

    it('setCustomEndpoint trims whitespace around the URL', () => {
      setCustomEndpoint('openai-compatible', '  http://localhost:11434/v1  ');
      expect(getCustomEndpoint('openai-compatible')).toBe('http://localhost:11434/v1');
    });

    it('setCustomEndpoint throws on empty URL', () => {
      expect(() => setCustomEndpoint('openai-compatible', '')).toThrow(/cannot be empty/i);
      expect(() => setCustomEndpoint('openai-compatible', '   ')).toThrow(/cannot be empty/i);
    });

    it('setCustomEndpoint throws on malformed URL', () => {
      expect(() => setCustomEndpoint('openai-compatible', 'not a url at all')).toThrow(/invalid/i);
    });

    it('setCustomEndpoint throws on unknown provider id', () => {
      expect(() => setCustomEndpoint('not-a-provider' as never, 'http://x')).toThrow(/unknown/i);
    });

    it('clearCustomEndpoint throws on unknown provider id', () => {
      expect(() => clearCustomEndpoint('not-a-provider' as never)).toThrow(/unknown/i);
    });

    it('setCustomEndpoint survives a fresh load via loadProviderConfig()', async () => {
      setCustomEndpoint('openai-compatible', 'http://localhost:11434/v1');
      setCustomEndpoint('minimax', 'http://minimax.local:8080/v1');
      const loaded = await loadProviderConfig();
      expect(loaded.customEndpoints['openai-compatible']).toBe('http://localhost:11434/v1');
      expect(loaded.customEndpoints.minimax).toBe('http://minimax.local:8080/v1');
    });

    it('loadProviderConfig() drops invalid keys + empty strings from customEndpoints', async () => {
      // Manually craft a config with junk to verify mergeCustomEndpoints sanitization.
      await fs.writeFile(
        testFile,
        JSON.stringify({
          activeProviderId: 'openai-compatible',
          modelByProvider: { 'openai-compatible': 'grok-4' },
          customEndpoints: {
            'openai-compatible': 'http://localhost:11434/v1',
            'minimax': '  ',           // whitespace-only — should be dropped
            'glm': 42,                  // non-string — should be dropped
            'fake-provider': 'http://x', // unknown id — should be dropped
            'grok': '',                  // empty — should be dropped
          },
        }),
        'utf-8',
      );
      const loaded = await loadProviderConfig();
      expect(loaded.customEndpoints['openai-compatible']).toBe('http://localhost:11434/v1');
      expect(loaded.customEndpoints.minimax).toBeUndefined();
      expect(loaded.customEndpoints.glm).toBeUndefined();
      expect(loaded.customEndpoints.grok).toBeUndefined();
      // The 'fake-provider' key isn't a known ProviderName, so check the raw blob.
      const rawKeys = Object.keys(loaded.customEndpoints);
      expect(rawKeys).not.toContain('fake-provider');
    });

    it('getProviderConfig() exposes customEndpoints field on defaults', () => {
      const config = getProviderConfig();
      expect(config.customEndpoints).toBeDefined();
      expect(config.customEndpoints).toEqual({});
    });
  });

  describe('resolveBaseUrl priority', () => {
    it('returns custom endpoint when set', () => {
      setCustomEndpoint('openai-compatible', 'http://ollama.local:11434/v1');
      expect(resolveBaseUrl('openai-compatible')).toBe('http://ollama.local:11434/v1');
    });

    it('custom endpoint wins over OPENAI_BASE_URL env', () => {
      process.env.OPENAI_BASE_URL = 'http://env-host:1234/v1';
      setCustomEndpoint('openai-compatible', 'http://persisted-host:5678/v1');
      expect(resolveBaseUrl('openai-compatible')).toBe('http://persisted-host:5678/v1');
    });

    it('OPENAI_BASE_URL env wins when no custom endpoint', () => {
      process.env.OPENAI_BASE_URL = 'http://env-host:1234/v1';
      expect(resolveBaseUrl('openai-compatible')).toBe('http://env-host:1234/v1');
    });

    it('falls back to PROVIDER_ENDPOINTS default for openai-compatible', () => {
      // No custom, no env → default for openai-compatible (api.x.ai/v1).
      expect(resolveBaseUrl('openai-compatible')).toBe('https://api.x.ai/v1');
    });

    it('falls back to PROVIDER_ENDPOINTS default for non-openai providers', () => {
      expect(resolveBaseUrl('minimax')).toBe('https://api.MiniMax.chat/v1');
      expect(resolveBaseUrl('glm')).toBe('https://api.z.ai/v1');
      expect(resolveBaseUrl('grok')).toBe('https://api.x.ai/v1');
    });

    it('custom endpoint works for non-openai providers too (vLLM-style)', () => {
      setCustomEndpoint('minimax', 'http://vllm.internal:8000/v1');
      expect(resolveBaseUrl('minimax')).toBe('http://vllm.internal:8000/v1');
    });
  });

  describe('slash command /provider custom', () => {
    it('/provider custom <url> → kind=provider_custom + customEndpoint', () => {
      const r = handleSlashCommand('/provider custom http://localhost:11434/v1', []);
      expect(r.handled).toBe(true);
      expect(r.kind).toBe('provider_custom');
      expect(r.customEndpoint).toBe('http://localhost:11434/v1');
      expect(r.customClear).toBeUndefined();
    });

    it('/provider custom clear → kind=provider_custom + customClear=true', () => {
      const r = handleSlashCommand('/provider custom clear', []);
      expect(r.handled).toBe(true);
      expect(r.kind).toBe('provider_custom');
      expect(r.customClear).toBe(true);
      expect(r.customEndpoint).toBeUndefined();
    });

    it('/provider custom with no args → usage hint, no side effects', () => {
      const r = handleSlashCommand('/provider custom', []);
      expect(r.handled).toBe(true);
      expect(r.kind).toBe('provider_custom');
      expect(r.customEndpoint).toBeUndefined();
      expect(r.customClear).toBeUndefined();
      expect(r.message).toMatch(/Usage/i);
    });

    it('/provider custom show → usage hint (no side effects)', () => {
      const r = handleSlashCommand('/provider custom show', []);
      expect(r.kind).toBe('provider_custom');
      expect(r.customEndpoint).toBeUndefined();
      expect(r.message).toMatch(/Usage/i);
    });

    it('/provider with no args returns provider_picker kind (v0.7.10 interactive picker)', () => {
      // Note: handleSlashCommand returns a static usage hint here. The picker
      // items are built by handleProviderPicker in slashHandlers/provider.ts.
      const r = handleSlashCommand('/provider', []);
      expect(r.handled).toBe(true);
      expect(r.kind).toBe('provider_picker');
      expect(r.message).toMatch(/Usage/i);
      // Also verify the hint message mentions the /provider custom subcommand.
      expect(r.message).toContain('/provider custom');
    });

    it('/provider grok (existing behavior) still returns provider_set', () => {
      const r = handleSlashCommand('/provider grok', []);
      expect(r.kind).toBe('provider_set');
      expect(r.provider).toBe('grok');
    });
  });
});