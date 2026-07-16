import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getProviderConfigPath,
  getProviderConfig,
  setActiveProviderId,
  setModelForProvider,
  getModelForProvider,
  getActiveProvider,
  getActiveModel,
  loadProviderConfig,
} from '../../src/cli/providerConfig.js';

describe('providerConfig', () => {
  let testFile: string;
  let savedEnvFile: string | undefined;
  let savedEnvActive: string | undefined;
  let savedEnvModel: string | undefined;

  beforeEach(() => {
    testFile = path.join(
      os.tmpdir(),
      `anathema-provider-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
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

  it('getProviderConfigPath() respects ANATHEMA_PROVIDER_CONFIG_FILE override', () => {
    expect(getProviderConfigPath()).toBe(testFile);
  });

  it('getProviderConfig() returns defaults when file missing', () => {
    const config = getProviderConfig();
    expect(config.activeProviderId).toBe('openai-compatible');
    expect(config.modelByProvider.grok).toBe('grok-4.5');
    expect(config.modelByProvider['openai-compatible']).toBe('grok-4.5');
    expect(config.modelByProvider.minimax).toBe('MiniMax-M2.5');
    expect(config.modelByProvider.glm).toBe('glm-4.6');
  });

  it('setActiveProviderId() persists + reads back', () => {
    setActiveProviderId('grok');
    const config = getProviderConfig();
    expect(config.activeProviderId).toBe('grok');
    // The grok model entry should already exist (defaults).
    expect(config.modelByProvider.grok).toBe('grok-4.5');
  });

  it('setActiveProviderId() throws on unknown id', () => {
    expect(() => setActiveProviderId('not-a-provider' as never)).toThrow(/Unknown provider id/);
  });

  it('setModelForProvider() persists + reads back', () => {
    setModelForProvider('grok', 'grok-3-turbo');
    expect(getModelForProvider('grok')).toBe('grok-3-turbo');
  });

  it('setModelForProvider() throws on empty model', () => {
    expect(() => setModelForProvider('grok', '  ')).toThrow(/cannot be empty/i);
  });

  it('setModelForProvider() throws on unknown provider id', () => {
    expect(() => setModelForProvider('not-a-provider' as never, 'm')).toThrow(/Unknown provider id/);
  });

  it('getActiveProvider() returns the active provider spec', () => {
    setActiveProviderId('minimax');
    const spec = getActiveProvider();
    expect(spec.id).toBe('minimax');
    expect(spec.envVar).toBe('MINIMAX_API_KEY');
  });

  it('getActiveModel() returns the model for the active provider', () => {
    setActiveProviderId('glm');
    setModelForProvider('glm', 'glm-4.5-air');
    expect(getActiveModel()).toBe('glm-4.5-air');
  });

  it('getProviderConfig() respects ANATHEMA_ACTIVE_PROVIDER env override', () => {
    process.env.ANATHEMA_ACTIVE_PROVIDER = 'grok';
    expect(getProviderConfig().activeProviderId).toBe('grok');
  });

  it('getProviderConfig() ignores invalid ANATHEMA_ACTIVE_PROVIDER', () => {
    process.env.ANATHEMA_ACTIVE_PROVIDER = 'fake-provider';
    expect(getProviderConfig().activeProviderId).toBe('openai-compatible');
  });

  it('getProviderConfig() respects OPENAI_MODEL env override', () => {
    process.env.OPENAI_MODEL = 'grok-2-vision';
    expect(getProviderConfig().modelByProvider['openai-compatible']).toBe('grok-2-vision');
  });

  it('setActiveProviderId() + setModelForProvider() round-trip with on-disk persistence', async () => {
    setActiveProviderId('grok');
    setModelForProvider('grok', 'grok-4-fast');
    // Read fresh (new instance semantics).
    const loaded = await loadProviderConfig();
    expect(loaded.activeProviderId).toBe('grok');
    expect(loaded.modelByProvider.grok).toBe('grok-4-fast');
  });

  it('loadProviderConfig() returns defaults when file missing', async () => {
    const loaded = await loadProviderConfig();
    expect(loaded.activeProviderId).toBe('openai-compatible');
  });

  it('loadProviderConfig() handles corrupt JSON gracefully', async () => {
    await fs.writeFile(testFile, '{ not valid json }', 'utf-8');
    const loaded = await loadProviderConfig();
    expect(loaded.activeProviderId).toBe('openai-compatible');
  });
});