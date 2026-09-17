/**
 * selectorsPublish.test.ts — the optional `publish` section schema (F3.2).
 * Back-compat: a file WITHOUT publish still validates. New: a file WITH a valid
 * publish chain validates; an invalid one is rejected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadSelectors } from './selectors.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'zelari-selp-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const base = {
  channel: 'x',
  loginUrl: 'https://x.com/login',
  loggedIn: [{ label: 'a', selector: '#a' }],
  loggedOut: [{ label: 'b', selector: '#b' }],
};

describe('publish selectors schema', () => {
  it('validates a file WITHOUT a publish section (back-compat)', async () => {
    await writeFile(path.join(dir, 'x.json'), JSON.stringify(base), 'utf-8');
    const sel = await loadSelectors('x', dir);
    expect(sel.publish).toBeUndefined();
  });

  it('validates a file WITH a valid publish section', async () => {
    await writeFile(
      path.join(dir, 'x.json'),
      JSON.stringify({
        ...base,
        publish: {
          textbox: [{ label: 'tb', selector: "div[role='textbox']" }],
          postButton: [{ label: 'btn', selector: "button[data-testid='tweetButton']" }],
          toastView: [{ label: 'toast', selector: "a[href*='/status/']" }],
        },
      }),
      'utf-8',
    );
    const sel = await loadSelectors('x', dir);
    expect(sel.publish?.textbox[0].selector).toContain('textbox');
    expect(sel.publish?.postButton).toHaveLength(1);
  });

  it('rejects a publish section missing the required textbox chain', async () => {
    await writeFile(
      path.join(dir, 'x.json'),
      JSON.stringify({ ...base, publish: { postButton: [{ label: 'b', selector: '#b' }] } }),
      'utf-8',
    );
    await expect(loadSelectors('x', dir)).rejects.toThrow(/invalid/);
  });
});

describe('real selectors files', () => {
  it('x.json carries a publish block (textbox + postButton chains)', async () => {
    const sel = await loadSelectors('x');
    expect(sel.publish).toBeDefined();
    expect(sel.publish?.textbox.length).toBeGreaterThan(0);
    expect(sel.publish?.postButton.length).toBeGreaterThan(0);
  });

  it('facebook.json carries a publish block (F3.3 chains)', async () => {
    const sel = await loadSelectors('facebook');
    expect(sel.publish).toBeDefined();
    expect(sel.publish?.textbox.length).toBeGreaterThan(0);
    expect(sel.publish?.postButton.length).toBeGreaterThan(0);
    expect(sel.loggedIn.length).toBeGreaterThan(0);
  });
});
