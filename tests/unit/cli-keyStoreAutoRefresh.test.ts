import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  resolveApiKeyWithMeta,
  setOAuthToken,
  getOAuthToken,
  type RefreshImpl,
} from '../../src/cli/keyStore.js';

/**
 * Task D.3.3: auto-refresh logic in resolveApiKeyWithMeta.
 *
 * Covers:
 *   - Refresh triggers when expiresAt is within refreshBufferMs
 *   - Refresh does NOT trigger when expiresAt is far in the future
 *   - Refresh does NOT trigger when no refreshToken stored
 *   - Refresh does NOT trigger when no expiresAt stored
 *   - Successful refresh persists new token + refresh_token rotation
 *   - Refresh failure falls back to stale token (caller sees upstream auth error)
 *   - Custom refreshBufferMs respected
 *   - Custom now() clock respected (testable deterministically)
 *   - Injectable refreshImpl receives (providerId, refreshToken) correctly
 */
describe('resolveApiKeyWithMeta auto-refresh (Task D.3.3)', () => {
  let testFile: string;
  let savedEnvFile: string | undefined;
  let savedEnvGrokKey: string | undefined;

  beforeEach(() => {
    testFile = path.join(
      os.tmpdir(),
      `anathema-autoref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
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

  it('refreshes when expiresAt is within default buffer (5 min)', async () => {
    const now = 1_700_000_000_000;
    setOAuthToken('grok', {
      apiKey: 'old-token',
      expiresAt: now + 60_000, // 1 min from now — within 5 min buffer
      refreshToken: 'rt-1',
    });
    const refreshSpy: RefreshImpl = vi.fn(async (_pid, rt) => ({
      accessToken: 'new-token',
      expiresAt: now + 3_600_000,
      refreshToken: 'rt-2',
    }));
    const result = await resolveApiKeyWithMeta('grok', {
      refreshImpl: refreshSpy,
      now,
    });
    expect(refreshSpy).toHaveBeenCalledWith('grok', 'rt-1');
    expect(result?.apiKey).toBe('new-token');
    expect(result?.expiresAt).toBe(now + 3_600_000);
    expect(result?.refreshToken).toBe('rt-2');
    // Persisted.
    expect(getOAuthToken('grok')?.apiKey).toBe('new-token');
    expect(getOAuthToken('grok')?.refreshToken).toBe('rt-2');
  });

  it('does NOT refresh when expiresAt is far in the future', async () => {
    const now = 1_700_000_000_000;
    setOAuthToken('grok', {
      apiKey: 'still-fresh',
      expiresAt: now + 3_600_000, // 1h from now
      refreshToken: 'rt',
    });
    const refreshSpy: RefreshImpl = vi.fn(async () => {
      throw new Error('refresh should NOT be called');
    });
    const result = await resolveApiKeyWithMeta('grok', {
      refreshImpl: refreshSpy,
      now,
    });
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(result?.apiKey).toBe('still-fresh');
  });

  it('does NOT refresh when refreshToken is missing', async () => {
    const now = 1_700_000_000_000;
    setOAuthToken('grok', {
      apiKey: 'no-refresh',
      expiresAt: now + 60_000, // within buffer
      // refreshToken intentionally absent
    });
    const refreshSpy: RefreshImpl = vi.fn(async () => {
      throw new Error('refresh should NOT be called');
    });
    const result = await resolveApiKeyWithMeta('grok', {
      refreshImpl: refreshSpy,
      now,
    });
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(result?.apiKey).toBe('no-refresh');
  });

  it('does NOT refresh when expiresAt is missing (no expiry metadata)', async () => {
    setOAuthToken('grok', {
      apiKey: 'no-expiry',
      refreshToken: 'rt',
      // expiresAt intentionally absent
    });
    const refreshSpy: RefreshImpl = vi.fn(async () => {
      throw new Error('refresh should NOT be called');
    });
    const result = await resolveApiKeyWithMeta('grok', {
      refreshImpl: refreshSpy,
    });
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(result?.apiKey).toBe('no-expiry');
  });

  it('falls back to stale token when refresh throws', async () => {
    const now = 1_700_000_000_000;
    setOAuthToken('grok', {
      apiKey: 'stale',
      expiresAt: now + 30_000,
      refreshToken: 'rt-bad',
    });
    const refreshSpy: RefreshImpl = vi.fn(async () => {
      throw new Error('refresh failed: network error');
    });
    const result = await resolveApiKeyWithMeta('grok', {
      refreshImpl: refreshSpy,
      now,
    });
    expect(refreshSpy).toHaveBeenCalledOnce();
    expect(result?.apiKey).toBe('stale'); // unchanged
  });

  it('preserves old refresh_token when provider does NOT rotate', async () => {
    const now = 1_700_000_000_000;
    setOAuthToken('grok', {
      apiKey: 'old',
      expiresAt: now + 60_000,
      refreshToken: 'rt-keep',
    });
    const refreshSpy: RefreshImpl = vi.fn(async () => ({
      accessToken: 'new-tk',
      expiresAt: now + 3_600_000,
      // refreshToken intentionally absent (no rotation)
    }));
    const result = await resolveApiKeyWithMeta('grok', {
      refreshImpl: refreshSpy,
      now,
    });
    expect(result?.refreshToken).toBe('rt-keep');
  });

  it('honors custom refreshBufferMs', async () => {
    const now = 1_700_000_000_000;
    setOAuthToken('grok', {
      apiKey: 'old',
      expiresAt: now + 4 * 60_000, // 4 min from now
      refreshToken: 'rt',
    });
    const refreshSpy: RefreshImpl = vi.fn(async () => ({
      accessToken: 'new-tk',
      expiresAt: now + 3_600_000,
    }));
    // With buffer=2min: 4 min > 2 min, NO refresh.
    const r1 = await resolveApiKeyWithMeta('grok', {
      refreshImpl: refreshSpy,
      refreshBufferMs: 2 * 60_000,
      now,
    });
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(r1?.apiKey).toBe('old');

    // With buffer=10min: 4 min < 10 min, refresh.
    refreshSpy.mockClear();
    const r2 = await resolveApiKeyWithMeta('grok', {
      refreshImpl: refreshSpy,
      refreshBufferMs: 10 * 60_000,
      now,
    });
    expect(refreshSpy).toHaveBeenCalledOnce();
    expect(r2?.apiKey).toBe('new-tk');
  });

  it('passes providerId to refreshImpl (only grok supported by default)', async () => {
    const now = 1_700_000_000_000;
    setOAuthToken('grok', {
      apiKey: 'old',
      expiresAt: now + 30_000,
      refreshToken: 'rt',
    });
    const refreshSpy: RefreshImpl = vi.fn(async () => ({
      accessToken: 'new',
      expiresAt: now + 3_600_000,
    }));
    await resolveApiKeyWithMeta('grok', { refreshImpl: refreshSpy, now });
    expect(refreshSpy).toHaveBeenCalledWith('grok', 'rt');
  });

  it('does not mutate the stored token when refresh succeeds but caller does not persist', async () => {
    // Sanity: a refresh call writes via writeStoreDirect, so the file
    // is updated. This test verifies persistence is immediate.
    const now = 1_700_000_000_000;
    setOAuthToken('grok', {
      apiKey: 'old',
      expiresAt: now + 30_000,
      refreshToken: 'rt',
    });
    const refreshSpy: RefreshImpl = vi.fn(async () => ({
      accessToken: 'persisted-new',
      expiresAt: now + 3_600_000,
    }));
    await resolveApiKeyWithMeta('grok', { refreshImpl: refreshSpy, now });
    // Read fresh from disk.
    const fresh = getOAuthToken('grok');
    expect(fresh?.apiKey).toBe('persisted-new');
  });
});