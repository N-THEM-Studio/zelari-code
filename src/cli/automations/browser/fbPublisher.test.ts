/**
 * fbPublisher.test.ts — the Facebook browser publisher, driven by FAKE pages (no
 * Playwright, no network). Covers the P1 health gate (zero interactions when not
 * logged in), the happy path permalink + evidence, and the invariant that a
 * missing permalink NEVER yields a fabricated url.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createFacebookBrowserPublisher,
  EVIDENCE_FILE,
  ReloginRequiredError,
  type ComposerPage,
} from './fbPublisher.js';
import type { ContextOpener, HealthReport } from './session.js';

// Real chains from selectors/facebook.json (kept verbatim; the JSON is the source).
const TEXTBOX = "[role='textbox'][contenteditable='true']";
const POST_BUTTON = "[role='button'][aria-label='Pubblica']";
const TOAST = "a[href*='/posts/']";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'zelari-fbpub-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface FakeOpts {
  present?: (sel: string) => boolean;
  hrefs?: (sel: string) => string[];
}

function fakePage(opts: FakeOpts = {}) {
  const calls: string[] = [];
  const typed: string[] = [];
  const page: ComposerPage = {
    goto: async (url) => {
      calls.push(`goto:${url}`);
    },
    url: () => 'https://www.facebook.com/',
    hasSelector: async (sel) => (opts.present ? opts.present(sel) : false),
    close: async () => undefined,
    click: async (sel) => {
      calls.push(`click:${sel}`);
    },
    typeText: async (_sel, text) => {
      typed.push(text);
    },
    press: async (key) => {
      calls.push(`press:${key}`);
    },
    screenshot: async () => {
      calls.push('screenshot');
    },
    hrefs: async (sel) => (opts.hrefs ? opts.hrefs(sel) : []),
    linkTexts: async () => [],
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

const build = (opener: ContextOpener, check = loggedIn) =>
  createFacebookBrowserPublisher({
    runId: 'R1',
    automationId: 'a1',
    cwd: dir,
    opener,
    checkLoginFn: check,
    delayMs: () => 0,
    sleep: async () => undefined,
  });

describe('createFacebookBrowserPublisher — happy path', () => {
  it('posts and extracts the /posts/<id> permalink + evidence screenshot', async () => {
    const { page, typed } = fakePage({
      present: (s) => s === TEXTBOX || s === POST_BUTTON || s === TOAST,
      hrefs: (s) => (s === TOAST ? ['https://www.facebook.com/mypage/posts/1234567890'] : []),
    });
    const adapter = build(openerWith(page));
    const res = await adapter.publish({ text: 'hello world' });

    expect(adapter.id).toBe('facebook');
    expect(typed.join('')).toBe('hello world');
    expect(res.dryRun).toBe(false);
    expect(res.postId).toBe('1234567890');
    expect(res.url).toBe('https://www.facebook.com/mypage/posts/1234567890');
    expect(res.screenshotPath?.endsWith(path.join('runs', 'a1', 'R1', EVIDENCE_FILE))).toBe(true);
  });
});

describe('createFacebookBrowserPublisher — health gate (P1)', () => {
  it('throws ReloginRequiredError and touches NOTHING when not logged in', async () => {
    const { page, calls } = fakePage({ present: () => true });
    const opener = vi.fn(openerWith(page));
    const adapter = build(opener, loggedOut);

    await expect(adapter.publish({ text: 'should not post' })).rejects.toBeInstanceOf(
      ReloginRequiredError,
    );
    expect(opener).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});

describe('createFacebookBrowserPublisher — never fabricates a permalink', () => {
  it('rejects when neither the toast nor the page search yields a permalink', async () => {
    const { page } = fakePage({ present: (s) => s === TEXTBOX || s === POST_BUTTON });
    const err = await build(openerWith(page))
      .publish({ text: 'hi' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PublishStepError');
    expect(err.step).toBe('post-toast');
  });
});
