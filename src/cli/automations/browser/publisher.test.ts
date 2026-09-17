/**
 * publisher.test.ts — the X browser publisher, driven entirely by FAKE pages (no
 * Playwright, no network). Covers the typing rhythm, primary/fallback permalink
 * extraction, media warnings, evidence path, the timeout step names, and — the
 * P1 invariant — that a relogin-required session touches NOTHING.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  COMPOSE_URL,
  createXBrowserPublisher,
  EVIDENCE_FILE,
  PublishStepError,
  ReloginRequiredError,
  type ComposerPage,
} from './publisher.js';
import type { ContextOpener, HealthReport } from './session.js';

// Real chains from selectors/x.json (kept verbatim; the JSON is the source).
const TEXTBOX = "div[data-testid='tweetTextarea_0'][role='textbox']";
const POST_BUTTON = "button[data-testid='tweetButton']";
const TOAST = "div[data-testid='toast'] a[href*='/status/']";
const FILE_INPUT = "input[type='file']";
const COMPOSE_ENTRY = "a[data-testid='SideNav_NewTweet_Button']";
const PROFILE_LINK = "a[data-testid='AppTabBar_Profile_Link']";
const PROFILE_POST = "article a[href*='/status/']";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'zelari-pub-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface FakeOpts {
  present?: (sel: string) => boolean;
  hrefs?: (sel: string) => string[];
  linkTexts?: (sel: string) => Array<{ href: string; text: string }>;
}

function fakePage(opts: FakeOpts = {}) {
  const calls: string[] = [];
  const typed: string[] = [];
  const page: ComposerPage = {
    goto: async (url) => {
      calls.push(`goto:${url}`);
    },
    url: () => 'https://x.com/compose/post',
    hasSelector: async (sel) => (opts.present ? opts.present(sel) : false),
    close: async () => undefined,
    click: async (sel) => {
      calls.push(`click:${sel}`);
    },
    typeText: async (sel, text) => {
      calls.push(`type:${sel}`);
      typed.push(text);
    },
    press: async (key) => {
      calls.push(`press:${key}`);
    },
    setInputFiles: async (sel, files) => {
      calls.push(`files:${sel}:${files.length}`);
    },
    screenshot: async () => {
      calls.push('screenshot');
    },
    hrefs: async (sel) => (opts.hrefs ? opts.hrefs(sel) : []),
    linkTexts: async (sel) => (opts.linkTexts ? opts.linkTexts(sel) : []),
  };
  return { page, calls, typed };
}

const openerWith =
  (page: ComposerPage): ContextOpener =>
  async () => ({
    newPage: async () => page,
    pages: () => [page],
    close: async () => undefined,
    onClose: () => undefined,
  });

const loggedIn = (channel: string): Promise<HealthReport> =>
  Promise.resolve({ channel, loggedIn: true, checkedAt: new Date().toISOString() });
const loggedOut = (channel: string): Promise<HealthReport> =>
  Promise.resolve({ channel, loggedIn: false, checkedAt: new Date().toISOString() });

const build = (opener: ContextOpener, check = loggedIn, delayMs = () => 0) =>
  createXBrowserPublisher({
    runId: 'R1',
    automationId: 'a1',
    cwd: dir,
    opener,
    checkLoginFn: check,
    delayMs,
    sleep: async () => undefined,
  });

describe('createXBrowserPublisher — happy path', () => {
  it('types the text char-by-char with the injected delay and extracts the toast permalink', async () => {
    const { page, typed, calls } = fakePage({
      present: (s) => s === TEXTBOX || s === POST_BUTTON || s === TOAST,
      hrefs: (s) => (s === TOAST ? ['/me/status/1234567890'] : []),
    });
    const delay = vi.fn(() => 0);
    const adapter = build(openerWith(page), loggedIn, delay);

    const res = await adapter.publish({ text: 'hello world' });

    expect(adapter.id).toBe('x');
    expect(typed.join('')).toBe('hello world');
    expect(delay).toHaveBeenCalledTimes('hello world'.length);
    expect(res.dryRun).toBe(false);
    expect(res.postId).toBe('1234567890');
    expect(res.url).toBe('https://x.com/me/status/1234567890');
    expect(res.screenshotPath?.endsWith(path.join('runs', 'a1', 'R1', EVIDENCE_FILE))).toBe(true);
    // Opened the composer via the direct URL, then clicked Post.
    expect(calls).toContain(`goto:${COMPOSE_URL}`);
    expect(calls).toContain(`click:${POST_BUTTON}`);
  });

  it('falls back to the profile search when the toast never appears', async () => {
    const body = 'a sufficiently long tweet body used to locate itself on the profile';
    const { page, calls } = fakePage({
      present: (s) => s === TEXTBOX || s === POST_BUTTON || s === PROFILE_LINK || s === PROFILE_POST,
      linkTexts: (s) => (s === PROFILE_POST ? [{ href: '/me/status/999', text: body }] : []),
    });
    const adapter = build(openerWith(page));
    const res = await adapter.publish({ text: body });
    expect(res.postId).toBe('999');
    expect(res.url).toBe('https://x.com/me/status/999');
    expect(calls).toContain(`click:${PROFILE_LINK}`);
  });

  it('opens the composer via the home entry when the direct URL shows no textbox', async () => {
    // /compose/post never renders the textbox; home + compose-entry does.
    let onCompose = true;
    const { page, calls } = fakePage({
      present: (s) => {
        if (s === TEXTBOX) return !onCompose;
        return s === COMPOSE_ENTRY || s === POST_BUTTON || s === TOAST;
      },
      hrefs: (s) => (s === TOAST ? ['https://x.com/me/status/42'] : []),
    });
    // Flip to home after the first goto (the compose attempt).
    page.goto = async (url) => {
      calls.push(`goto:${url}`);
      if (url.includes('/home')) onCompose = false;
    };
    const res = await build(openerWith(page)).publish({ text: 'hi' });
    expect(res.postId).toBe('42');
    expect(calls).toContain(`click:${COMPOSE_ENTRY}`);
  });
});

describe('createXBrowserPublisher — media', () => {
  it('warns (never aborts) when the media selector is missing', async () => {
    const { page } = fakePage({
      present: (s) => s === TEXTBOX || s === POST_BUTTON || s === TOAST,
      hrefs: () => ['/me/status/7'],
    });
    const res = await build(openerWith(page)).publish({ text: 'hi', mediaPaths: ['/tmp/a.png'] });
    expect(res.warnings?.some((w) => /media selector missing/.test(w))).toBe(true);
    expect(res.postId).toBe('7');
  });

  it('attaches media when the file input is present', async () => {
    const { page, calls } = fakePage({
      present: (s) => s === TEXTBOX || s === POST_BUTTON || s === TOAST || s === FILE_INPUT,
      hrefs: () => ['/me/status/8'],
    });
    const res = await build(openerWith(page)).publish({ text: 'hi', mediaPaths: ['/tmp/a.png'] });
    expect(calls).toContain(`files:${FILE_INPUT}:1`);
    expect(res.warnings ?? []).toHaveLength(0);
  });
});

describe('createXBrowserPublisher — health gate (P1)', () => {
  it('throws ReloginRequiredError and touches NOTHING when the session is not logged in', async () => {
    const { page, calls } = fakePage({ present: () => true });
    const opener = vi.fn(openerWith(page));
    const adapter = build(opener, loggedOut);

    await expect(adapter.publish({ text: 'should not post' })).rejects.toBeInstanceOf(
      ReloginRequiredError,
    );
    // No page opened, no interaction, no navigation — zero blind posting.
    expect(opener).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('does not type anything when relogin is required', async () => {
    const { page, typed } = fakePage({ present: () => true });
    const adapter = build(openerWith(page), loggedOut);
    await adapter.publish({ text: 'nope' }).catch(() => undefined);
    expect(typed).toHaveLength(0);
  });
});

describe('createXBrowserPublisher — step errors carry the failing step', () => {
  it('names composer-textbox when the textbox never renders', async () => {
    const { page } = fakePage({ present: (s) => s === COMPOSE_ENTRY });
    const err = await build(openerWith(page))
      .publish({ text: 'hi' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PublishStepError);
    expect(err.step).toBe('composer-textbox');
  });

  it('names post-button when the Post button is absent', async () => {
    const { page } = fakePage({ present: (s) => s === TEXTBOX });
    const err = await build(openerWith(page))
      .publish({ text: 'hi' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PublishStepError);
    expect(err.step).toBe('post-button');
  });

  it('names post-toast when neither toast nor profile yields a permalink', async () => {
    const { page } = fakePage({ present: (s) => s === TEXTBOX || s === POST_BUTTON });
    const err = await build(openerWith(page))
      .publish({ text: 'hi' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PublishStepError);
    expect(err.step).toBe('post-toast');
  });
});
