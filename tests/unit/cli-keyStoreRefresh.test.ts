import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  setApiKey,
  getStoredApiKey,
  setOAuthToken,
  getOAuthToken,
  clearApiKey,
  resolveApiKey,
  resolveApiKeyWithMeta,
  loadStoredKeys,
  type StoredKey,
} from '../../src/cli/keyStore.js';

/**
 * Tasks D.1.1-D.1.4: keyStore extended with OAuth metadata.
 *
 * Covers:
 *   - Backward compat: pre-v3-D JSON files with bare-string provider entries
 *   - setOAuthToken / getOAuthToken round-trip + optional fields
 *   - resolveApiKeyWithMeta (env first, then store, both branches)
 *   - File corruption / partial files → safe fallback
 *   - Deep-clone semantics (mutating returned object doesn't bleed into store)
 */
describe('keyStore OAuth refresh-token extension (Task D.1)', () => {
  let testFile: string;
  let savedEnvFile: string | undefined;
  let savedEnvGrokKey: string | undefined;

  beforeEach(() => {
    testFile = path.join(
      os.tmpdir(),
      `anathema-keys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
    );
    savedEnvFile = process.env.ANATHEMA_KEYSTORE_FILE;
    savedEnvGrokKey = process.env.GROK_API_KEY;
    process.env.ANATHEMA_KEYSTORE_FILE = testFile;
    delete process.env.GROK_API_KEY;
  });

  afterEach(async () => {
    if (savedEnvFile === undefined) delete process.env.ANATHEMA_KEYSTORE_FILE;
    else process.env.ANATHEMA_KEYSTORE_FILE = savedEnvFile;
    if (savedEnvGrokKey === undefined) delete process.env.GROK_API_KEY;
    else process.env.GROK_API_KEY = savedEnvGrokKey;
    await fs.rm(testFile, { force: true });
  });

  describe('Backward compatibility (legacy bare-string format)', () => {
    it('reads legacy keys.json with bare-string provider entries', async () => {
      // Manually craft a pre-v3-D file shape.
      await fs.writeFile(
        testFile,
        JSON.stringify({
          providers: {
            grok: 'legacy-bare-token-1234567890',
            minimax: 'minimax-key-abcdef',
          },
        }),
        'utf-8',
      );

      // getStoredApiKey should still return the bare string.
      expect(getStoredApiKey('grok')).toBe('legacy-bare-token-1234567890');
      expect(getStoredApiKey('minimax')).toBe('minimax-key-abcdef');
      expect(getStoredApiKey('unknown')).toBeNull();
    });

    it('resolveApiKeyWithMeta upgrades legacy bare-string to StoredKey', async () => {
      await fs.writeFile(
        testFile,
        JSON.stringify({ providers: { grok: 'legacy-token' } }),
        'utf-8',
      );
      const meta = await resolveApiKeyWithMeta('grok');
      expect(meta).toEqual<StoredKey>({ apiKey: 'legacy-token' });
      // expiresAt + refreshToken must NOT be present.
      expect(meta?.expiresAt).toBeUndefined();
      expect(meta?.refreshToken).toBeUndefined();
    });

    it('legacy file → write back via setApiKey → reads back as StoredKey', async () => {
      await fs.writeFile(
        testFile,
        JSON.stringify({ providers: { grok: 'legacy-token' } }),
        'utf-8',
      );
      setApiKey('grok', 'new-token');
      const meta = getOAuthToken('grok');
      expect(meta).toEqual<StoredKey>({ apiKey: 'new-token' });
      // The on-disk shape should now be the object form.
      const raw = await fs.readFile(testFile, 'utf-8');
      const parsed = JSON.parse(raw) as { providers: Record<string, unknown> };
      expect(parsed.providers.grok).toEqual({ apiKey: 'new-token' });
    });

    it('loadStoredKeys() still returns Record<string, string> for legacy files', async () => {
      await fs.writeFile(
        testFile,
        JSON.stringify({
          providers: {
            grok: 'g',
            minimax: 'm',
          },
        }),
        'utf-8',
      );
      const loaded = await loadStoredKeys();
      expect(loaded).toEqual({ grok: 'g', minimax: 'm' });
    });
  });

  describe('setOAuthToken + getOAuthToken', () => {
    it('setOAuthToken + getOAuthToken round-trip with all fields', () => {
      const expiresAt = Date.now() + 3600_000;
      const refreshToken = 'rt-abcdef-1234567890';
      setOAuthToken('grok', {
        apiKey: 'access-token-xyz',
        expiresAt,
        refreshToken,
      });
      const got = getOAuthToken('grok');
      expect(got).toEqual<StoredKey>({
        apiKey: 'access-token-xyz',
        expiresAt,
        refreshToken,
      });
    });

    it('setOAuthToken with only apiKey omits expiresAt + refreshToken', () => {
      setOAuthToken('grok', { apiKey: 'just-a-key' });
      const got = getOAuthToken('grok');
      expect(got).toEqual<StoredKey>({ apiKey: 'just-a-key' });
      expect(got?.expiresAt).toBeUndefined();
      expect(got?.refreshToken).toBeUndefined();
    });

    it('setOAuthToken drops invalid expiresAt (NaN, non-finite)', () => {
      setOAuthToken('grok', {
        apiKey: 'k',
        expiresAt: Number.NaN,
        refreshToken: 'rt',
      });
      const got = getOAuthToken('grok');
      expect(got?.expiresAt).toBeUndefined();
      // refreshToken survives because it's a valid string.
      expect(got?.refreshToken).toBe('rt');
    });

    it('setOAuthToken drops empty refreshToken', () => {
      setOAuthToken('grok', {
        apiKey: 'k',
        expiresAt: 1234,
        refreshToken: '',
      });
      const got = getOAuthToken('grok');
      expect(got?.refreshToken).toBeUndefined();
      expect(got?.expiresAt).toBe(1234);
    });

    it('setOAuthToken overwrites previous entry', () => {
      setOAuthToken('grok', { apiKey: 'first', refreshToken: 'rt-first' });
      setOAuthToken('grok', { apiKey: 'second' });
      expect(getStoredApiKey('grok')).toBe('second');
      expect(getOAuthToken('grok')?.refreshToken).toBeUndefined();
    });

    it('getOAuthToken returns null for unknown provider', () => {
      expect(getOAuthToken('unknown')).toBeNull();
    });
  });

  describe('resolveApiKeyWithMeta (env first, then store)', () => {
    it('returns env var path as { apiKey } without expiry metadata', async () => {
      process.env.GROK_API_KEY = 'env-key-123';
      const meta = await resolveApiKeyWithMeta('grok');
      expect(meta).toEqual<StoredKey>({ apiKey: 'env-key-123' });
      expect(meta?.expiresAt).toBeUndefined();
    });

    it('env var wins over stored OAuth token', async () => {
      setOAuthToken('grok', {
        apiKey: 'stored-token',
        expiresAt: Date.now() + 1000,
        refreshToken: 'rt',
      });
      process.env.GROK_API_KEY = 'env-token';
      const meta = await resolveApiKeyWithMeta('grok');
      expect(meta?.apiKey).toBe('env-token');
    });

    it('falls back to stored OAuth token when env is unset', async () => {
      const expiresAt = Date.now() + 60_000;
      setOAuthToken('grok', {
        apiKey: 'stored-token',
        expiresAt,
        refreshToken: 'rt-stored',
      });
      const meta = await resolveApiKeyWithMeta('grok');
      expect(meta).toEqual<StoredKey>({
        apiKey: 'stored-token',
        expiresAt,
        refreshToken: 'rt-stored',
      });
    });

    it('returns null when neither env nor store has the key', async () => {
      expect(await resolveApiKeyWithMeta('grok')).toBeNull();
    });

    it('resolveApiKey() still returns the bare string (backward compat)', () => {
      setOAuthToken('grok', { apiKey: 'k', expiresAt: 1234, refreshToken: 'rt' });
      expect(resolveApiKey('grok')).toBe('k');
    });
  });

  describe('File corruption / edge cases', () => {
    it('falls back to empty store when JSON is corrupt', async () => {
      await fs.writeFile(testFile, '{ not valid json }', 'utf-8');
      expect(getStoredApiKey('grok')).toBeNull();
      expect(await resolveApiKeyWithMeta('grok')).toBeNull();
    });

    it('drops entries with invalid shapes (not string, not object)', async () => {
      await fs.writeFile(
        testFile,
        JSON.stringify({
          providers: {
            grok: 'valid-string',
            minimax: 42,           // number — invalid
            glm: null,             // null — invalid
            custom: { foo: 'bar' }, // object without apiKey — invalid
            custom2: { apiKey: '' }, // empty apiKey — invalid
          },
        }),
        'utf-8',
      );
      expect(getStoredApiKey('grok')).toBe('valid-string');
      expect(getStoredApiKey('minimax')).toBeNull();
      expect(getStoredApiKey('glm')).toBeNull();
      expect(getStoredApiKey('custom')).toBeNull();
      expect(getStoredApiKey('custom2')).toBeNull();
    });

    it('returns empty store when file is missing (no throw)', async () => {
      // No setup file at all.
      expect(getStoredApiKey('grok')).toBeNull();
      expect(await resolveApiKeyWithMeta('grok')).toBeNull();
    });

    it('clearApiKey removes both legacy bare-string and new object entries', async () => {
      await fs.writeFile(
        testFile,
        JSON.stringify({
          providers: { grok: 'legacy-token', minimax: 'minimax-legacy' },
        }),
        'utf-8',
      );
      clearApiKey('grok');
      setOAuthToken('minimax', { apiKey: 'oauth-token', refreshToken: 'rt' });
      clearApiKey('minimax');
      expect(getStoredApiKey('grok')).toBeNull();
      expect(getStoredApiKey('minimax')).toBeNull();
    });
  });

  describe('Deep-clone semantics (avoid shared mutation)', () => {
    it('mutating returned StoredKey does not affect subsequent reads', () => {
      setOAuthToken('grok', { apiKey: 'original', refreshToken: 'rt-orig' });
      const got = getOAuthToken('grok');
      expect(got).not.toBeNull();
      // Mutate the returned object.
      got!.apiKey = 'MUTATED';
      got!.refreshToken = 'MUTATED';
      // Subsequent reads should return the original, not the mutation.
      const got2 = getOAuthToken('grok');
      expect(got2?.apiKey).toBe('original');
      expect(got2?.refreshToken).toBe('rt-orig');
    });
  });
});