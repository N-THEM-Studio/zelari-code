/**
 * fbComposer.test.ts — the Facebook composer flow, driven by FAKE pages (no
 * Playwright, no network). Covers permalink grammar (extracted, never
 * fabricated), the COM-dominated open fallback, human-like typing, media
 * warnings and the evidence path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  EVIDENCE_FILE,
  FB_HOME_URL,
  FB_PROFILE_ME_URL,
  isFacebookPermalink,
  openComposer,
  runFacebookComposerPublish,
  type ComposerPage,
  toFacebookPermalink,
} from './fbComposer.js';
import { PublishStepError, ReloginRequiredError } from './errors.js';
import { loadSelectors } from './selectors.js';

// Real chains from selectors/facebook.json (kept verbatim; the JSON is the source).
const SEL = await loadSelectors('facebook');
const TEXTBOX = SEL.publish!.textbox[0].selector;
const POST_BUTTON = SEL.publish!.postButton[0].selector;
const TOAST = SEL.publish!.toastView![0].selector;
const FILE_INPUT = SEL.publish!.fileInput![0].selector;
const COMPOSE_ENTRY = SEL.publish!.composeEntry![0].selector;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'zelari-fb-'));
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
    url: () => 'https://www.facebook.com/',
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
    clickText: async (_scope, texts) => {
      calls.push(`clickText:${texts[0]}`);
      return texts[0] ?? null;
    },
  };
  return { page, calls, typed };
}

const runOpts = { cwd: '', automationId: 'a1', runId: 'R1', delayMs: () => 0, sleep: async () => undefined };

describe('toFacebookPermalink — accepted shapes (extracted only)', () => {
  it('accepts /<page>/posts/<digits>', () => {
    const p = toFacebookPermalink('/mypage/posts/123456', 'post-toast');
    expect(p.postId).toBe('123456');
    expect(p.url).toBe('https://www.facebook.com/mypage/posts/123456');
  });

  it('accepts /share/p/<token>', () => {
    const p = toFacebookPermalink('https://www.facebook.com/share/p/AbC123xyz/', 'post-toast');
    expect(p.postId).toBe('AbC123xyz');
  });

  it('accepts permalink.php?story_fbid=<digits>&id=<digits>', () => {
    const p = toFacebookPermalink('permalink.php?story_fbid=987654&id=555', 'post-toast');
    expect(p.postId).toBe('987654');
  });

  it('rejects fb.watch links (never a permalink)', () => {
    expect(() => toFacebookPermalink('https://fb.watch/abcDEF/', 'post-toast')).toThrow(
      PublishStepError,
    );
    expect(isFacebookPermalink('https://fb.watch/abcDEF/')).toBe(false);
  });

  it('rejects a link with no facebook permalink shape', () => {
    expect(isFacebookPermalink('https://www.facebook.com/notifications')).toBe(false);
  });
});

describe('openComposer — facebook', () => {
  it('returns the direct textbox when it renders immediately', async () => {
    const { page, calls } = fakePage({ present: (s) => s === TEXTBOX });
    const textbox = await openComposer(page, SEL);
    expect(textbox).toBe(TEXTBOX);
    expect(calls).toContain(`goto:${FB_HOME_URL}`);
  });

  it('clicks the "Create a post" entry when no textbox renders directly', async () => {
    let opened = false;
    const { page, calls } = fakePage({
      present: (s) => (s === TEXTBOX ? opened : s === COMPOSE_ENTRY),
    });
    page.click = async (sel) => {
      calls.push(`click:${sel}`);
      opened = true;
    };
    const textbox = await openComposer(page, SEL);
    expect(textbox).toBe(TEXTBOX);
    expect(calls).toContain(`click:${COMPOSE_ENTRY}`);
  });

  it('navigates to a configured pageUrl when given', async () => {
    const { page, calls } = fakePage({ present: (s) => s === TEXTBOX });
    await openComposer(page, SEL, { pageUrl: 'https://www.facebook.com/mypage' });
    expect(calls).toContain('goto:https://www.facebook.com/mypage');
  });

  it('throws composer-textbox when neither the textbox nor the entry appears', async () => {
    const { page } = fakePage({ present: (s) => s === COMPOSE_ENTRY });
    const err = await openComposer(page, SEL).catch((e) => e);
    expect(err).toBeInstanceOf(PublishStepError);
    expect(err.step).toBe('composer-textbox');
  });
});

describe('runFacebookComposerPublish', () => {
  it('types char-by-char and returns the toast permalink + evidence', async () => {
    const { page, typed, calls } = fakePage({
      present: (s) => s === TEXTBOX || s === POST_BUTTON || s === TOAST,
      hrefs: (s) => (s === TOAST ? ['https://www.facebook.com/mypage/posts/123'] : []),
    });
    const delay = vi.fn(() => 0);
    const res = await runFacebookComposerPublish(page, SEL, { text: 'hello world' }, {
      ...runOpts,
      cwd: dir,
      delayMs: delay,
    });

    expect(typed.join('')).toBe('hello world');
    expect(delay).toHaveBeenCalledTimes('hello world'.length);
    expect(res.dryRun).toBe(false);
    expect(res.postId).toBe('123');
    expect(res.url).toBe('https://www.facebook.com/mypage/posts/123');
    expect(res.screenshotPath?.endsWith(path.join('runs', 'a1', 'R1', EVIDENCE_FILE))).toBe(true);
    expect(calls.some((c) => c === `click:${POST_BUTTON}` || c.startsWith('clickText:'))).toBe(true);
  });

  it('warns (never aborts) when the media selector is missing', async () => {
    const { page } = fakePage({
      present: (s) => s === TEXTBOX || s === POST_BUTTON || s === TOAST,
      hrefs: () => ['https://www.facebook.com/mypage/posts/7'],
    });
    const res = await runFacebookComposerPublish(page, SEL, { text: 'hi', mediaPaths: ['/tmp/a.png'] }, {
      ...runOpts,
      cwd: dir,
    });
    expect(res.warnings?.some((w) => /media selector missing/.test(w))).toBe(true);
    expect(res.postId).toBe('7');
  });

  it('attaches media when the file input is present', async () => {
    const { page, calls } = fakePage({
      present: (s) => s === TEXTBOX || s === POST_BUTTON || s === TOAST || s === FILE_INPUT,
      hrefs: () => ['https://www.facebook.com/mypage/posts/8'],
    });
    const res = await runFacebookComposerPublish(page, SEL, { text: 'hi', mediaPaths: ['/tmp/a.png'] }, {
      ...runOpts,
      cwd: dir,
    });
    expect(calls).toContain(`files:${FILE_INPUT}:1`);
    expect(res.warnings ?? []).toHaveLength(0);
  });

  it('never ships a substring Pubblica selector (matches "pubblicato" toasts)', () => {
    const chain = SEL.publish!.postButton ?? [];
    for (const e of chain) {
      expect(e.selector.toLowerCase()).not.toMatch(/aria-label\*=['\"]pubblica/i);
    }
  });

  it('does not scope Avanti/Pubblica to role=dialog (composer chrome is a sibling)', () => {
    for (const e of [...(SEL.publish!.postButton ?? []), ...(SEL.publish!.advanceButtons ?? [])]) {
      expect(e.selector).not.toMatch(/role=['"]dialog['"]/);
    }
  });

  it('falls through to exact clickText when Playwright click times out on an invisible match', async () => {
    const { page, calls } = fakePage({
      present: (s) => s === TEXTBOX || s === POST_BUTTON || s === TOAST,
      hrefs: () => ['https://www.facebook.com/mypage/posts/77'],
    });
    page.click = async (sel) => {
      calls.push(`click:${sel}`);
      throw new Error('page.click: Timeout 10000ms exceeded. element is not visible');
    };
    const res = await runFacebookComposerPublish(page, SEL, { text: 'hi' }, { ...runOpts, cwd: dir });
    expect(calls.some((c) => c.startsWith('clickText:'))).toBe(true);
    expect(res.postId).toBe('77');
  });

  it('throws post-toast (never a fabricated url) when no permalink is found', async () => {
    const { page } = fakePage({ present: (s) => s === TEXTBOX || s === POST_BUTTON });
    const err = await runFacebookComposerPublish(page, SEL, { text: 'hi' }, { ...runOpts, cwd: dir }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(PublishStepError);
    expect(err.step).toBe('post-toast');
  });

  it('falls back to the page search when the toast never appears', async () => {
    const body = 'a sufficiently long facebook body used to locate itself on the page';
    const { page } = fakePage({
      present: (s) =>
        s === TEXTBOX || s === POST_BUTTON || s === SEL.publish!.profileLink![0].selector ||
        s === SEL.publish!.profilePost![0].selector,
      linkTexts: (s) =>
        s === SEL.publish!.profilePost![0].selector
          ? [{ href: '/mypage/posts/999', text: body }]
          : [],
    });
    const res = await runFacebookComposerPublish(page, SEL, { text: body }, { ...runOpts, cwd: dir });
    expect(res.postId).toBe('999');
  });
});

describe('openComposer pre-gates (GDPR wall + server-side logout)', () => {
  const CONSENT = SEL.consentButtons![0].selector;
  const LOGGED_OUT = SEL.publish!.loggedOutMarkers![0].selector;

  it('dismisses the cookie wall when present, then opens the composer', async () => {
    const { page, calls } = fakePage({
      present: (s) => s === CONSENT || s === TEXTBOX,
    });
    const matched = await openComposer(page, SEL);
    expect(matched).toBe(TEXTBOX);
    expect(calls).toContain(`click:${CONSENT}`);
  });

  it('stops with ReloginRequired (zero clicks) when the server answered logged-out', async () => {
    const { page, calls } = fakePage({ present: (s) => s === LOGGED_OUT });
    const err = await openComposer(page, SEL).catch((e) => e);
    expect(err).toBeInstanceOf(ReloginRequiredError);
    expect(calls).toHaveLength(1); // the goto only — no click, no typing
  });
});
