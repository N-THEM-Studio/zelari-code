/**
 * registry.test.ts — the mode-aware channel factory (F3.2/F3.3). Hermetic: the
 * browser adapters are built with injected fakes (no Playwright, no network) and
 * the website adapter with an injected fetch + config.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DRY_RUN_CHANNELS, resolveAdapter, resolveChannelAdapter } from './registry.js';
import type { ComposerPage } from '../browser/publisher.js';
import type { ContextOpener, HealthReport } from '../browser/session.js';

const TEXTBOX = "div[data-testid='tweetTextarea_0'][role='textbox']";
const POST_BUTTON = "button[data-testid='tweetButton']";
const TOAST = "div[data-testid='toast'] a[href*='/status/']";

// Real facebook.json chains (the JSON is the source).
const FB_TEXTBOX = "[role='textbox'][contenteditable='true']";
const FB_POST = "[aria-label='Post'][role='button']";
const FB_TOAST = "a[href*='/posts/']";

function composerPage(): ComposerPage {
  return {
    goto: async () => undefined,
    url: () => 'https://x.com/compose/post',
    hasSelector: async (s) => s === TEXTBOX || s === POST_BUTTON || s === TOAST,
    close: async () => undefined,
    click: async () => undefined,
    typeText: async () => undefined,
    press: async () => undefined,
    screenshot: async () => undefined,
    hrefs: async (s) => (s === TOAST ? ['/me/status/555'] : []),
    linkTexts: async () => [],
  };
}

function facebookPage(): ComposerPage {
  return {
    goto: async () => undefined,
    url: () => 'https://www.facebook.com/',
    hasSelector: async (s) => s === FB_TEXTBOX || s === FB_POST || s === FB_TOAST,
    close: async () => undefined,
    click: async () => undefined,
    typeText: async () => undefined,
    press: async () => undefined,
    screenshot: async () => undefined,
    hrefs: async (s) => (s === FB_TOAST ? ['https://www.facebook.com/mypage/posts/123'] : []),
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

const opener = openerWith(composerPage());

const loggedIn = (channel: string): Promise<HealthReport> =>
  Promise.resolve({ channel, loggedIn: true, checkedAt: new Date().toISOString() });

describe('resolveAdapter — dry-run (default)', () => {
  it('defaults to a network-free dry-run adapter for every supported channel', async () => {
    for (const id of DRY_RUN_CHANNELS) {
      const adapter = resolveAdapter(id, { runId: 'R' });
      const res = await adapter.publish({ text: 'hi' });
      expect(adapter.id).toBe(id);
      expect(res.dryRun).toBe(true);
      expect(res.url).toContain('dry-run');
    }
  });

  it('throws a clear error for an unknown channel', () => {
    expect(() => resolveAdapter('mastodon', { runId: 'R' })).toThrow(/unknown channel: mastodon/);
  });
});

describe('resolveAdapter — browser', () => {
  it("builds the real X browser adapter for channel 'x'", async () => {
    const adapter = resolveAdapter('x', {
      publishMode: 'browser',
      runId: 'R',
      automationId: 'a',
      browser: { opener, checkLoginFn: loggedIn, delayMs: () => 0, sleep: async () => undefined },
    });
    expect(adapter.id).toBe('x');
    const res = await adapter.publish({ text: 'hi' });
    expect(res.dryRun).toBe(false);
    expect(res.url).toBe('https://x.com/me/status/555');
  });

  it("builds the real Facebook browser adapter for channel 'facebook' (F3.3)", async () => {
    const adapter = resolveAdapter('facebook', {
      publishMode: 'browser',
      runId: 'R',
      automationId: 'a',
      facebook: {
        opener: openerWith(facebookPage()),
        checkLoginFn: loggedIn,
        delayMs: () => 0,
        sleep: async () => undefined,
      },
    });
    expect(adapter.id).toBe('facebook');
    const res = await adapter.publish({ text: 'hi' });
    expect(res.dryRun).toBe(false);
    expect(res.url).toBe('https://www.facebook.com/mypage/posts/123');
  });

  it("builds the website webhook adapter for 'website' (HTTP, no browser)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ url: 'https://example.test/p/1', postId: 'p1' }), {
        status: 200,
      })) as unknown as typeof fetch;
    const adapter = resolveAdapter('website', {
      publishMode: 'browser',
      runId: 'R',
      automationId: 'a',
      website: { config: { endpoint: 'https://hook.test/x', secret: 'k' }, fetchImpl },
    });
    expect(adapter.id).toBe('website');
    const res = await adapter.publish({ text: 'hi' });
    expect(res.dryRun).toBe(false);
    expect(res.url).toBe('https://example.test/p/1');
  });

  it('builds website, and a MISSING config fails LOUD at publish (clear error, no crash)', async () => {
    const prev = {
      dir: process.env.ZELARI_CHANNELS_DIR,
      url: process.env.ZELARI_WEBSITE_WEBHOOK_URL,
      secret: process.env.ZELARI_WEBSITE_WEBHOOK_SECRET,
    };
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'zelari-cred-'));
    process.env.ZELARI_CHANNELS_DIR = tmp;
    delete process.env.ZELARI_WEBSITE_WEBHOOK_URL;
    delete process.env.ZELARI_WEBSITE_WEBHOOK_SECRET;
    try {
      const adapter = resolveAdapter('website', { publishMode: 'browser', runId: 'R' });
      expect(adapter.id).toBe('website');
      await expect(adapter.publish({ text: 'hi' })).rejects.toThrow(/endpoint is required/);
    } finally {
      const restore = (k: string, v: string | undefined): void => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      };
      restore('ZELARI_CHANNELS_DIR', prev.dir);
      restore('ZELARI_WEBSITE_WEBHOOK_URL', prev.url);
      restore('ZELARI_WEBSITE_WEBHOOK_SECRET', prev.secret);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('still rejects an unknown channel in browser mode', () => {
    expect(() => resolveAdapter('mastodon', { publishMode: 'browser', runId: 'R' })).toThrow(
      /unknown channel: mastodon/,
    );
  });
});

describe('resolveChannelAdapter — F2 back-compat', () => {
  it('resolves a dry-run adapter (unchanged semantics)', async () => {
    const adapter = resolveChannelAdapter('x', 'RUN2');
    const res = await adapter.publish({ text: 'hi' });
    expect(adapter.id).toBe('x');
    expect(res.dryRun).toBe(true);
  });
});
