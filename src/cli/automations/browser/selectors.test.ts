/**
 * selectors.test.ts — load + validate the real per-channel selector JSON, plus
 * the failure modes (malformed, schema-invalid, channel mismatch) with tmp
 * fixtures. No browser, no network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isSupportedChannel,
  loadSelectors,
  moduleRelativeSelectorsDirs,
  selectorsDir,
  SUPPORTED_CHANNELS,
} from './selectors.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'zelari-sel-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadSelectors (real data)', () => {
  it('loads the real x selectors with the fallback order preserved', async () => {
    const sel = await loadSelectors('x');
    expect(sel.channel).toBe('x');
    expect(sel.loginUrl).toContain('x.com');
    expect(sel.loggedIn.map((e) => e.label)).toEqual(['compose-button', 'home-timeline', 'home-link']);
    // The current X login page matches input[name='password'] first.
    expect(sel.loggedOut[0].selector).toContain('password');
  });

  it('loads the real facebook selectors', async () => {
    const sel = await loadSelectors('facebook');
    expect(sel.channel).toBe('facebook');
    expect(sel.loginUrl).toContain('facebook.com');
    expect(sel.loggedIn.length).toBeGreaterThan(0);
    expect(sel.loggedOut.length).toBeGreaterThan(0);
  });

  it('lists exactly the channels that have a selectors file', () => {
    expect([...SUPPORTED_CHANNELS]).toEqual(['x', 'facebook']);
    expect(isSupportedChannel('x')).toBe(true);
    expect(isSupportedChannel('tiktok')).toBe(false);
  });

  it('selectorsDir honours an explicit override', () => {
    expect(selectorsDir('/custom/dir')).toBe('/custom/dir');
    expect(selectorsDir()).toMatch(/selectors$/);
  });
});

describe('loadSelectors (failure modes)', () => {
  it('rejects an unknown channel', async () => {
    await expect(loadSelectors('tiktok')).rejects.toThrow(/unknown social channel/);
  });

  it('rejects a missing file with a clear message', async () => {
    await expect(loadSelectors('x', dir)).rejects.toThrow(/selectors file not found/);
  });

  it('rejects malformed JSON', async () => {
    await writeFile(path.join(dir, 'x.json'), '{ not: valid json', 'utf-8');
    await expect(loadSelectors('x', dir)).rejects.toThrow(/malformed JSON/);
  });

  it('rejects a schema-invalid document', async () => {
    await writeFile(path.join(dir, 'x.json'), JSON.stringify({ channel: 'x' }), 'utf-8');
    await expect(loadSelectors('x', dir)).rejects.toThrow(/invalid/);
  });

  it('rejects a file whose channel does not match the request', async () => {
    await writeFile(
      path.join(dir, 'x.json'),
      JSON.stringify({
        channel: 'facebook',
        loginUrl: 'https://x.com/login',
        loggedIn: [{ label: 'a', selector: '#a' }],
        loggedOut: [{ label: 'b', selector: '#b' }],
      }),
      'utf-8',
    );
    await expect(loadSelectors('x', dir)).rejects.toThrow(/expected "x"/);
  });
});

describe('selectorsDir cwd-independence (bundled CLI from any cwd)', () => {
  // Regression: the Desktop spawns the bundled CLI with cwd = the user's
  // workdir (NOT the repo root). Resolution must not depend on process.cwd().
  const testDir = path.dirname(fileURLToPath(import.meta.url)); // src/cli/automations/browser
  const repoRoot = path.resolve(testDir, '..', '..', '..', '..');

  it('reaches the source tree from a simulated <pkgRoot>/dist/cli bundle location', () => {
    const here = path.join(repoRoot, 'dist', 'cli');
    const expected = path.join(repoRoot, 'src', 'cli', 'automations', 'browser', 'selectors');
    expect(moduleRelativeSelectorsDirs(here)).toContain(expected);
    expect(existsSync(expected)).toBe(true);
  });
});
