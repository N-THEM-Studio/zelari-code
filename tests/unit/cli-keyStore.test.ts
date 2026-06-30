import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  setApiKey,
  clearApiKey,
  getStoredApiKey,
  resolveApiKey,
  getProviderSpec,
  getKeyStorePath,
  loadStoredKeys,
  maskKey,
  PROVIDERS,
} from '../../src/cli/keyStore.js';
import { handleSlashCommand } from '../../src/cli/slashCommands.js';

describe('keyStore', () => {
  let testStore: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    testStore = path.join(
      os.tmpdir(),
      `anathema-keys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
    );
    savedEnv = process.env.ANATHEMA_KEYSTORE_FILE;
    process.env.ANATHEMA_KEYSTORE_FILE = testStore;
  });

  afterEach(async () => {
    if (savedEnv === undefined) delete process.env.ANATHEMA_KEYSTORE_FILE;
    else process.env.ANATHEMA_KEYSTORE_FILE = savedEnv;
    await fs.rm(testStore, { force: true });
  });

  it('PROVIDERS list contains the 4 expected providers', () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(ids).toContain('openai-compatible');
    expect(ids).toContain('minimax');
    expect(ids).toContain('glm');
    expect(ids).toContain('grok');
  });

  it('getProviderSpec() returns the spec for known providers, undefined for unknown', () => {
    expect(getProviderSpec('grok')?.envVar).toBe('GROK_API_KEY');
    expect(getProviderSpec('minimax')?.displayName).toBe('MiniMax');
    expect(getProviderSpec('unknown-provider')).toBeUndefined();
  });

  it('getKeyStorePath() respects ANATHEMA_KEYSTORE_FILE override', () => {
    expect(getKeyStorePath()).toBe(testStore);
  });

  it('setApiKey + getStoredApiKey roundtrip', () => {
    expect(getStoredApiKey('minimax')).toBeNull();
    setApiKey('minimax', 'sk-test-123');
    expect(getStoredApiKey('minimax')).toBe('sk-test-123');
    setApiKey('minimax', 'sk-test-456');
    expect(getStoredApiKey('minimax')).toBe('sk-test-456');
  });

  it('clearApiKey removes the stored key', () => {
    setApiKey('glm', 'sk-glm-789');
    expect(getStoredApiKey('glm')).toBe('sk-glm-789');
    clearApiKey('glm');
    expect(getStoredApiKey('glm')).toBeNull();
    // Idempotent: clearing again is a no-op.
    expect(() => clearApiKey('glm')).not.toThrow();
  });

  it('resolveApiKey() prefers env var over stored key', () => {
    setApiKey('grok', 'sk-stored');
    process.env.GROK_API_KEY = 'sk-from-env';
    expect(resolveApiKey('grok')).toBe('sk-from-env');
    delete process.env.GROK_API_KEY;
  });

  it('resolveApiKey() falls back to stored key when env unset', () => {
    delete process.env.GROK_API_KEY;
    setApiKey('grok', 'sk-stored-2');
    expect(resolveApiKey('grok')).toBe('sk-stored-2');
  });

  it('resolveApiKey() returns null when neither env nor store set', () => {
    delete process.env.GROK_API_KEY;
    expect(resolveApiKey('grok')).toBeNull();
  });

  it('maskKey() shows first/last 4 chars + length for long keys', () => {
      expect(maskKey('sk-1234567890abcdef')).toBe('sk-1…cdef (len=19)');
      expect(maskKey('short')).toBe('****');
    });

  it('loadStoredKeys() async roundtrip', async () => {
    setApiKey('minimax', 'sk-async-1');
    setApiKey('grok', 'sk-async-2');
    const all = await loadStoredKeys();
    expect(all.minimax).toBe('sk-async-1');
    expect(all.grok).toBe('sk-async-2');
  });

  it('loadStoredKeys() returns {} when file missing', async () => {
    const fresh = path.join(os.tmpdir(), `never-existed-${Date.now()}.json`);
    process.env.ANATHEMA_KEYSTORE_FILE = fresh;
    const all = await loadStoredKeys();
    expect(all).toEqual({});
  });
});

describe('slashCommands /login', () => {
  it('/login <provider> without key: grok triggers OAuth flow', () => {
    const result = handleSlashCommand('/login grok', []);
    expect(result.handled).toBe(true);
    expect(result.kind).toBe('login_oauth');
    expect(result.provider).toBe('grok');
    expect(result.loginKey).toBeUndefined();
  });

  it('/login <provider> without key: non-oauth provider returns usage hint', () => {
    const result = handleSlashCommand('/login minimax', []);
    expect(result.handled).toBe(true);
    expect(result.kind).toBe('login');
    expect(result.provider).toBe('minimax');
    expect(result.loginKey).toBeUndefined();
    expect(result.message).toMatch(/no key/i);
  });

  it('/login <provider> <key> returns handled + provider + loginKey', () => {
    const result = handleSlashCommand('/login grok sk-test-xyz', []);
    expect(result.handled).toBe(true);
    expect(result.kind).toBe('login');
    expect(result.provider).toBe('grok');
    expect(result.loginKey).toBe('sk-test-xyz');
  });

  it('/login <provider> <key> handles keys with spaces (joined as one arg)', () => {
    const result = handleSlashCommand('/login grok  sk-abc 123 ', []);
    expect(result.handled).toBe(true);
    expect(result.loginKey).toBe('sk-abc 123');
  });

  it('/login without args returns usage', () => {
    const result = handleSlashCommand('/login', []);
    expect(result.handled).toBe(true);
    expect(result.message).toMatch(/Usage/i);
    expect(result.loginKey).toBeUndefined();
  });
});