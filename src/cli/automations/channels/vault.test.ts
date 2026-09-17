/**
 * vault.test.ts — the per-channel credential vault (F3.3). Fully offline: the
 * vault directory is redirected to a tmp dir via ZELARI_CHANNELS_DIR.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { channelsDir, loadVault, removeVault, saveVault, vaultPath } from './vault.js';

let dir: string;
let prev: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'zelari-vault-'));
  prev = process.env.ZELARI_CHANNELS_DIR;
  process.env.ZELARI_CHANNELS_DIR = dir;
});

afterEach(async () => {
  if (prev === undefined) delete process.env.ZELARI_CHANNELS_DIR;
  else process.env.ZELARI_CHANNELS_DIR = prev;
  await rm(dir, { recursive: true, force: true });
});

describe('vault', () => {
  it('redirects the vault directory via ZELARI_CHANNELS_DIR', () => {
    expect(channelsDir()).toBe(dir);
    expect(vaultPath('website')).toBe(path.join(dir, 'website.json'));
  });

  it('round-trips a saved config', async () => {
    await saveVault('website', { endpoint: 'https://x.test/h', secret: 's3cr3t' });
    expect(await loadVault('website')).toEqual({ endpoint: 'https://x.test/h', secret: 's3cr3t' });
  });

  it('returns null when the vault file is absent', async () => {
    expect(await loadVault('missing')).toBeNull();
  });

  it('throws a clear error on malformed JSON', async () => {
    await writeFile(vaultPath('website'), '{ not json', 'utf-8');
    await expect(loadVault('website')).rejects.toThrow(/malformed JSON/);
  });

  it('removes a vault file (and is tolerant when absent)', async () => {
    await saveVault('website', { endpoint: 'https://x.test/h', secret: 's' });
    await removeVault('website');
    expect(await loadVault('website')).toBeNull();
    await expect(removeVault('website')).resolves.toBeUndefined();
  });
});
