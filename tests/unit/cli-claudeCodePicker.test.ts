/**
 * Claude Code (abbonamento) is a picker entry, not an API-key or OAuth provider.
 * Login stays `claude auth login` on the official binary; Zelari stores no token.
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applySetKey, buildDesktopConfigSnapshot } from '../../src/cli/desktopConfig.js';
import { decideLocalCliRoute, resolveHeadlessKey } from '../../src/cli/headless.js';
import {
  OAUTH_PROVIDER_IDS,
  PROVIDERS,
  getStoredApiKey,
  setApiKey,
} from '../../src/cli/keyStore.js';
import { PROVIDER_ENDPOINTS } from '../../src/cli/provider/openai-compatible.js';
import { getBuiltinDefaultModel } from '../../src/cli/providerConfig.js';
import { resolveServedTurnStream } from '../../src/cli/serve/harnessServer.js';
import { handleSlashCommand } from '../../src/cli/slashCommands.js';
import { PROVIDER_THINKING_CAPABILITY } from '../../src/cli/thinking.js';
import type { HeadlessOptions } from '../../src/cli/headless.js';

describe('claudeCode picker', () => {
  let keyFile: string;
  let providerFile: string;
  let modelsFile: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    keyFile = path.join(os.tmpdir(), `zelari-cc-keys-${id}.json`);
    providerFile = path.join(os.tmpdir(), `zelari-cc-provider-${id}.json`);
    modelsFile = path.join(os.tmpdir(), `zelari-cc-models-${id}.json`);
    for (const name of ['ANATHEMA_KEYSTORE_FILE', 'ANATHEMA_PROVIDER_CONFIG_FILE', 'ANATHEMA_MODELS_FILE', 'ZELARI_LOCAL_CLI']) {
      saved[name] = process.env[name];
    }
    process.env.ANATHEMA_KEYSTORE_FILE = keyFile;
    process.env.ANATHEMA_PROVIDER_CONFIG_FILE = providerFile;
    process.env.ANATHEMA_MODELS_FILE = modelsFile;
    delete process.env.ZELARI_LOCAL_CLI;
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('lists Claude Code (abbonamento) separately from Anthropic and not as OAuth', () => {
    const claudeCode = PROVIDERS.find((p) => p.id === 'claudeCode');
    const anthropic = PROVIDERS.find((p) => p.id === 'anthropic');
    expect(claudeCode).toMatchObject({
      id: 'claudeCode',
      displayName: 'Claude Code (abbonamento)',
      envVar: '',
    });
    expect(claudeCode?.baseUrl).toBeUndefined();
    expect(anthropic).toMatchObject({
      id: 'anthropic',
      displayName: 'Anthropic Claude (OAuth)',
      envVar: 'ANTHROPIC_API_KEY',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(OAUTH_PROVIDER_IDS).not.toContain('claudeCode');
    expect(OAUTH_PROVIDER_IDS).toContain('anthropic');
    expect(getBuiltinDefaultModel('claudeCode')).toBe('claude-sonnet-4-6');
    expect(PROVIDER_THINKING_CAPABILITY.claudeCode).toEqual({});
    expect(PROVIDER_ENDPOINTS.claudeCode).toBe('');
  });

  it('setApiKey(claudeCode) throws before writing a subscription token', () => {
    expect(() => setApiKey('claudeCode', 'sk-ant-fake')).toThrow(/claude auth login/);
    expect(existsSync(keyFile)).toBe(false);
    expect(getStoredApiKey('claudeCode')).toBeNull();
  });

  it('desktop snapshot marks claudeCode as cli auth and refuses --set-key', () => {
    const snap = buildDesktopConfigSnapshot();
    const entry = snap.providers.find((p) => p.id === 'claudeCode');
    expect(entry).toMatchObject({
      id: 'claudeCode',
      displayName: 'Claude Code (abbonamento)',
      authKind: 'cli',
      oauthSupported: false,
    });
    expect(entry?.apiStyle).toBeUndefined();
    expect(entry?.hasKey).toBe(false);

    const refused = applySetKey({ provider: 'claudeCode', key: 'sk-ant-fake' });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toMatch(/claude auth login/);
    expect(refused.error).not.toMatch(/save a key|stored API key|Set the env var/i);
    expect(existsSync(keyFile)).toBe(false);
  });

  it('resolveHeadlessKey(claudeCode) errors without claiming a key was stored', async () => {
    const result = await resolveHeadlessKey('claudeCode');
    expect(result).toEqual({
      error: expect.stringMatching(/claude auth login/),
    });
    expect('apiKey' in result).toBe(false);
    if ('error' in result) {
      expect(result.error).not.toMatch(/save a key|Set the env var|via \/login/i);
      expect(result.error).toMatch(/does not store subscription tokens/);
    }
  });

  it('routes claudeCode to the official binary and lets ZELARI_LOCAL_CLI override it', async () => {
    expect(decideLocalCliRoute({ providerId: 'claudeCode', localCliEnv: '' })).toEqual({
      kind: 'claude-code',
      cli: 'claude',
      providerId: 'claudeCode',
    });
    expect(decideLocalCliRoute({
      providerId: 'claudeCode',
      localCliEnv: 'codex',
      model: 'claude-sonnet-4-6',
    })).toEqual({
      kind: 'env-override',
      cli: 'codex',
      providerId: 'local-cli',
    });
    expect(decideLocalCliRoute({ providerId: 'grok', localCliEnv: '  ' })).toEqual({
      kind: 'api-key',
    });

    const turn = await resolveServedTurnStream({
      task: 't',
      provider: 'claudeCode',
      model: 'claude-sonnet-4-6',
    } as HeadlessOptions);
    expect(turn.provider).toBe('claudeCode');
    expect(typeof turn.stream).toBe('function');

    process.env.ZELARI_LOCAL_CLI = 'codex';
    const overridden = await resolveServedTurnStream({
      task: 't',
      provider: 'claudeCode',
      model: 'claude-sonnet-4-6',
    } as HeadlessOptions);
    expect(overridden.provider).toBe('local-cli');
  });

  it('/login claudeCode does not start OAuth or accept a key', () => {
    const bare = handleSlashCommand('/login claudeCode', []);
    expect(bare.handled).toBe(true);
    expect(bare.kind).toBe('login');
    expect(bare.kind).not.toBe('login_oauth');
    expect(bare.loginKey).toBeUndefined();
    expect(bare.message).toMatch(/claude auth login/);

    const withKey = handleSlashCommand('/login claudeCode sk-ant-fake', []);
    expect(withKey.handled).toBe(true);
    expect(withKey.kind).not.toBe('login_oauth');
    expect(withKey.loginKey).toBeUndefined();
    expect(withKey.message).toMatch(/does not store subscription tokens/);

    const help = handleSlashCommand('/provider', []);
    expect(help.message).toMatch(/claudeCode, custom/);
  });
});
