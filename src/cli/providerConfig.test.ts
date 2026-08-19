import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getProviderConfig,
  loadProviderConfig,
  setKrakenVerifier,
  clearKrakenVerifier,
  setCustomEndpoint,
  setActiveProviderId,
} from './providerConfig.js';

const ENV_KEYS = ['ANATHEMA_PROVIDER_CONFIG_FILE', 'ANATHEMA_ACTIVE_PROVIDER', 'OPENAI_MODEL'] as const;

/**
 * Exit-0 E0.2 — sync/async round-trip parity for provider config.
 * Regression guard for E0.1: `loadProviderConfig()` (async) used to silently
 * drop `krakenVerifier` and skip env overrides on the fallback path.
 */
describe('providerConfig sync/async round-trip (E0.1/E0.2)', () => {
  let tmpDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'zelari-providerconfig-'));
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.ANATHEMA_PROVIDER_CONFIG_FILE = path.join(tmpDir, 'provider.json');
    delete process.env.ANATHEMA_ACTIVE_PROVIDER;
    delete process.env.OPENAI_MODEL;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a dedicated krakenVerifier survives an async load (E0.1 regression)', async () => {
    setKrakenVerifier('anthropic', 'claude-sonnet-4-6');
    const asyncCfg = await loadProviderConfig();
    expect(asyncCfg.krakenVerifier).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
  });

  it('clearKrakenVerifier → back to inherit on both sync and async paths', async () => {
    setKrakenVerifier('grok', 'grok-4.6');
    clearKrakenVerifier();
    expect(getProviderConfig().krakenVerifier).toBeUndefined();
    expect((await loadProviderConfig()).krakenVerifier).toBeUndefined();
  });

  it('sync and async loads are deep-equal for a populated config', async () => {
    setActiveProviderId('grok');
    setCustomEndpoint('openai-compatible', 'http://localhost:11434/v1');
    setKrakenVerifier('anthropic', 'claude-sonnet-4-6');
    expect(await loadProviderConfig()).toEqual(getProviderConfig());
  });

  it('env overrides win on both paths (async fallback included)', async () => {
    setActiveProviderId('grok');
    process.env.ANATHEMA_ACTIVE_PROVIDER = 'anthropic';
    process.env.OPENAI_MODEL = 'claude-opus-4-6';
    const syncCfg = getProviderConfig();
    const asyncCfg = await loadProviderConfig();
    for (const cfg of [syncCfg, asyncCfg]) {
      expect(cfg.activeProviderId).toBe('anthropic');
      expect(cfg.modelByProvider['anthropic']).toBe('claude-opus-4-6');
    }
  });

  it('missing file → cloned defaults, no shared mutable state across loads', async () => {
    const first = await loadProviderConfig();
    first.modelByProvider['grok'] = 'MUTATED';
    const second = getProviderConfig();
    expect(second.modelByProvider['grok']).not.toBe('MUTATED');
  });

  it('corrupt file → defaults on both paths', async () => {
    writeFileSync(path.join(tmpDir, 'provider.json'), '{ not json', 'utf-8');
    const asyncCfg = await loadProviderConfig();
    const syncCfg = getProviderConfig();
    expect(asyncCfg.activeProviderId).toBe(syncCfg.activeProviderId);
    expect(asyncCfg.modelByProvider).toEqual(syncCfg.modelByProvider);
    expect(asyncCfg.krakenVerifier).toBeUndefined();
  });

  it('hand-edited partial krakenVerifier blob is dropped by both paths', async () => {
    writeFileSync(
      path.join(tmpDir, 'provider.json'),
      JSON.stringify({
        activeProviderId: 'grok',
        modelByProvider: { grok: 'grok-4.6' },
        krakenVerifier: { provider: 'anthropic' }, // model missing → invalid, must fall back to inherit
      }),
      'utf-8',
    );
    expect(getProviderConfig().krakenVerifier).toBeUndefined();
    expect((await loadProviderConfig()).krakenVerifier).toBeUndefined();
  });
});
