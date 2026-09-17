/**
 * probePublish.test.ts — the `probe --publish` composer steps, driven by a fake
 * browser (no Playwright). Verifies the extra steps appear, succeed on a healthy
 * page, and degrade to "skipped" when the browser is unavailable.
 */
import { describe, expect, it } from 'vitest';
import { runProbe } from './probe.js';
import type { ComposerPage } from './publisher.js';
import type { ContextOpener } from './session.js';

const TEXTBOX = "div[data-testid='tweetTextarea_0'][role='textbox']";
const POST_BUTTON = "button[data-testid='tweetButton']";
const LOGGED_IN = "[data-testid='SideNav_NewTweet_Button']";

function composerPage(present: (s: string) => boolean): ComposerPage {
  return {
    goto: async () => undefined,
    url: () => 'https://x.com/compose/post',
    hasSelector: async (s) => present(s),
    close: async () => undefined,
    click: async () => undefined,
    typeText: async () => undefined,
    press: async () => undefined,
    screenshot: async () => undefined,
    hrefs: async () => [],
    linkTexts: async () => [],
  };
}

const openerWith =
  (page: ComposerPage): ContextOpener =>
  async () => ({
    newPage: async () => page,
    pages: () => [page],
    close: async () => undefined,
    onClose: () => undefined,
  });

const base = { available: async () => true, profileExists: () => true };

describe('runProbe --publish', () => {
  it('appends composer-open + post-button steps and passes on a healthy page', async () => {
    const page = composerPage((s) => s === LOGGED_IN || s === TEXTBOX || s === POST_BUTTON);
    const r = await runProbe('x', { ...base, opener: openerWith(page), publish: true });
    expect(r.steps.map((s) => s.step)).toEqual([
      'browser-available',
      'profile-exists',
      'goto-login',
      'login-state',
      'composer-open',
      'post-button',
    ]);
    expect(r.steps.find((s) => s.step === 'composer-open')?.ok).toBe(true);
    expect(r.steps.find((s) => s.step === 'post-button')?.ok).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('fails composer-open when the textbox never renders (stale selectors)', async () => {
    const page = composerPage((s) => s === LOGGED_IN);
    const r = await runProbe('x', { ...base, opener: openerWith(page), publish: true });
    expect(r.steps.find((s) => s.step === 'composer-open')?.ok).toBe(false);
    expect(r.ok).toBe(false);
  });

  it('adds two skipped steps when the browser is unavailable', async () => {
    const r = await runProbe('x', { available: async () => false, profileExists: () => true, publish: true });
    expect(r.steps).toHaveLength(6);
    expect(r.steps.find((s) => s.step === 'composer-open')?.detail).toMatch(/browser unavailable/);
    expect(r.steps.find((s) => s.step === 'post-button')?.detail).toMatch(/browser unavailable/);
  });

  it('without --publish keeps the 4 original steps', async () => {
    const page = composerPage((s) => s === LOGGED_IN);
    const r = await runProbe('x', { ...base, opener: openerWith(page) });
    expect(r.steps.map((s) => s.step)).toEqual([
      'browser-available',
      'profile-exists',
      'goto-login',
      'login-state',
    ]);
  });

  it('runs the facebook --publish steps with the channel-specific composer opener', async () => {
    const FB_LOGGED_IN = "[role='navigation'][aria-label='Facebook']";
    const FB_TEXTBOX = "[role='textbox'][contenteditable='true']";
    const FB_POST_BUTTON = "[role='button'][aria-label='Pubblica']";
    const page = composerPage(
      (s) => s === FB_LOGGED_IN || s === FB_TEXTBOX || s === FB_POST_BUTTON,
    );
    const r = await runProbe('facebook', { ...base, opener: openerWith(page), publish: true });
    expect(r.steps.map((s) => s.step)).toEqual([
      'browser-available',
      'profile-exists',
      'goto-login',
      'login-state',
      'composer-open',
      'post-button',
    ]);
    expect(r.steps.find((s) => s.step === 'composer-open')?.ok).toBe(true);
    expect(r.steps.find((s) => s.step === 'post-button')?.ok).toBe(true);
    expect(r.ok).toBe(true);
  });
});
