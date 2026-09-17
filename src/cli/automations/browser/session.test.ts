/**
 * session.test.ts — profile paths + login-state orchestration with a FAKE
 * browser. `os.homedir` is mocked so the profile path is deterministic; the
 * injected context opener means no real Playwright/Chromium is ever launched.
 */
import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => '/home/tester' };
});

import {
  checkLogin,
  DEFAULT_LOGIN_TIMEOUT_SEC,
  openLoginSession,
  PLAYWRIGHT_UNAVAILABLE_HINT,
  profileDir,
  type BrowserPageLike,
  type ContextOpener,
  type PersistentContextLike,
} from './session.js';

function fakePage(match: (selector: string) => boolean): BrowserPageLike {
  return {
    goto: async () => undefined,
    url: () => 'https://x.com/home',
    close: async () => undefined,
    hasSelector: async (selector) => match(selector),
  };
}

function fakeContext(
  page: BrowserPageLike,
  onCloseNow = true,
  cookieNames?: string[],
): PersistentContextLike {
  return {
    newPage: async () => page,
    pages: () => [page],
    close: async () => undefined,
    onClose: (cb) => {
      if (onCloseNow) cb();
    },
    ...(cookieNames ? { cookies: async () => cookieNames.map((name) => ({ name })) } : {}),
  };
}

const openerWith = (
  page: BrowserPageLike,
  onCloseNow = true,
  cookieNames?: string[],
): ContextOpener => async () => fakeContext(page, onCloseNow, cookieNames);

describe('profileDir', () => {
  it('builds <homedir>/.zelari-code/browser-profiles/<channel>', () => {
    expect(profileDir('x')).toBe(path.join('/home/tester', '.zelari-code', 'browser-profiles', 'x'));
    expect(profileDir('facebook')).toBe(
      path.join('/home/tester', '.zelari-code', 'browser-profiles', 'facebook'),
    );
  });

  it('throws on an unsupported channel', () => {
    expect(() => profileDir('tiktok')).toThrow(/unknown social channel/);
  });
});

describe('checkLogin', () => {
  it('reports logged-in and the matching label', async () => {
    const opener = openerWith(fakePage((s) => s === "[data-testid='SideNav_NewTweet_Button']"));
    const report = await checkLogin('x', { opener });
    expect(report.loggedIn).toBe(true);
    expect(report.matched).toBe('compose-button');
    expect(report.channel).toBe('x');
    expect(Number.isNaN(Date.parse(report.checkedAt))).toBe(false);
  });

  it('reports logged-out when only a loggedOut selector matches', async () => {
    const opener = openerWith(fakePage((s) => s === "input[name='password']"));
    const report = await checkLogin('x', { opener });
    expect(report.loggedIn).toBe(false);
    expect(report.matched).toBe('login-password');
  });

  it('reports logged-out with no matched label when nothing matches', async () => {
    const report = await checkLogin('facebook', { opener: openerWith(fakePage(() => false)) });
    expect(report.loggedIn).toBe(false);
    expect(report.matched).toBeUndefined();
  });

  it('closes the context even when it matches', async () => {
    const close = vi.fn(async () => undefined);
    const opener: ContextOpener = async () => ({
      newPage: async () => fakePage(() => true),
      pages: () => [fakePage(() => true)],
      close,
      onClose: () => undefined,
    });
    await checkLogin('x', { opener });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('throws (technical) when Playwright is unavailable', async () => {
    await expect(checkLogin('x', { opener: async () => null })).rejects.toThrow(
      PLAYWRIGHT_UNAVAILABLE_HINT,
    );
  });

  it('rejects an unknown channel before touching the browser', async () => {
    await expect(checkLogin('tiktok', { opener: async () => null })).rejects.toThrow(
      /unknown social channel/,
    );
  });
});

describe('openLoginSession', () => {
  it('confirms ok when the profile ends logged in', async () => {
    const opener = openerWith(fakePage((s) => s === "[data-testid='SideNav_NewTweet_Button']"));
    const res = await openLoginSession('x', { opener, timeoutSec: 1, log: () => undefined });
    expect(res.ok).toBe(true);
    expect(res.loggedIn).toBe(true);
    expect(res.reason).toBeUndefined();
  });

  it('returns ok:false (unproven) when the window closes but no login is seen', async () => {
    const opener = openerWith(fakePage(() => false));
    const res = await openLoginSession('x', { opener, timeoutSec: 1, log: () => undefined });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no logged-in state/);
  });

  it('throws (technical) when Playwright is unavailable', async () => {
    await expect(
      openLoginSession('x', { opener: async () => null, log: () => undefined }),
    ).rejects.toThrow(PLAYWRIGHT_UNAVAILABLE_HINT);
  });

  it('rejects an unknown channel', async () => {
    await expect(openLoginSession('tiktok', { log: () => undefined })).rejects.toThrow(
      /unknown social channel/,
    );
  });

  it('exposes a sane default timeout', () => {
    expect(DEFAULT_LOGIN_TIMEOUT_SEC).toBe(300);
  });
});

describe('checkLogin — cookie-based primary signal (locale-proof)', () => {
  it('logged in via profile cookies even when no DOM selector matches', async () => {
    const opener = openerWith(fakePage(() => false), true, ['auth_token', 'ct0', 'twid']);
    const report = await checkLogin('x', { opener });
    expect(report.loggedIn).toBe(true);
    expect(report.matched).toBe('cookies:auth_token');
  });

  it('logged out when a required session cookie is missing (c_user without xs)', async () => {
    const opener = openerWith(fakePage(() => false), true, ['c_user', 'fr']);
    const report = await checkLogin('facebook', { opener });
    expect(report.loggedIn).toBe(false);
    expect(report.matched).toBe('cookies:missing xs');
  });

  it('openLoginSession confirms via cookies when the DOM chains cannot match', async () => {
    const opener = openerWith(fakePage(() => false), true, ['auth_token']);
    const res = await openLoginSession('x', { opener, timeoutSec: 1, log: () => undefined });
    expect(res.ok).toBe(true);
    expect(res.loggedIn).toBe(true);
  });

  it('auto-detects the login while the window is open and closes it (cookie poll)', async () => {
    // onCloseNow = false: the window never closes — only the cookie poll can
    // end the session, which is exactly the new UX (auto-close on login).
    const opener = openerWith(fakePage(() => false), false, ['auth_token']);
    const res = await openLoginSession('x', {
      opener,
      timeoutSec: 2,
      loginPollMs: 20,
      log: () => undefined,
    });
    expect(res.ok).toBe(true);
    expect(res.loggedIn).toBe(true);
  });
});
