/**
 * automations/browser/session.ts — persistent-profile browser sessions (F3.1).
 *
 * Manual HUMAN login; cookies live under
 *   <os.homedir()>/.zelari-code/browser-profiles/<channel>/
 *   - openLoginSession: headed window → user logs in → close/timeout → headless confirm.
 *   - checkLogin:       headless → is this profile currently logged in?
 *
 * Playwright is loaded lazily via the existing browser_check loader, so it stays
 * an OPTIONAL dependency (no static import, no new dep). All access goes through
 * the minimal seams in ./pageAdapter.ts, so the orchestration is unit-testable
 * with a fake browser (tests never launch Chromium). The page/context seams are
 * re-exported here for back-compat with existing importers.
 */
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { loadPlaywright } from '../../browser/driver.js';
import { isSupportedChannel, loadSelectors, SUPPORTED_CHANNELS } from './selectors.js';
import {
  adaptContext,
  SELECTOR_TIMEOUT_MS,
  type BrowserPageLike,
  type ContextOpener,
  type PersistentContextLike,
  type PwModuleLike,
} from './pageAdapter.js';

export {
  SELECTOR_TIMEOUT_MS,
  type BrowserPageLike,
  type ContextOpener,
  type PersistentContextLike,
} from './pageAdapter.js';

/** Navigation timeout for a login-state check (short on purpose). */
export const NAV_TIMEOUT_MS = 15_000;
/** Default window for the manual login before we give up (seconds). */
export const DEFAULT_LOGIN_TIMEOUT_SEC = 300;

/** Shown verbatim when Playwright is absent — same UX as the browser_check gate. */
export const PLAYWRIGHT_UNAVAILABLE_HINT =
  'browser automation unavailable — Playwright is not installed in this workspace. ' +
  'Install it with: `zelari-code --plugins-install playwright --cwd .` ' +
  '(or Desktop banner “Install”, or CLI `/plugins install playwright`, or ' +
  '`npm i -D playwright && npx playwright install chromium`).';

/** Result of a headless login-state check. */
export interface HealthReport {
  channel: string;
  loggedIn: boolean;
  /** Label of the selector that decided the state (when one matched). */
  matched?: string;
  /** ISO-8601 timestamp of the check. */
  checkedAt: string;
}

/** Result of a manual login session (ok only when the headless confirm passed). */
export interface LoginSessionResult {
  ok: boolean;
  reason?: string;
  loginUrl: string;
  loggedIn: boolean;
}

/** `<os.homedir()>/.zelari-code/browser-profiles/<channel>/`. Throws if unknown. */
export function profileDir(channel: string): string {
  if (!isSupportedChannel(channel)) {
    throw new Error(
      `unknown social channel: ${channel} (supported: ${SUPPORTED_CHANNELS.join(', ')})`,
    );
  }
  return path.join(homedir(), '.zelari-code', 'browser-profiles', channel);
}

const nowIso = (): string => new Date().toISOString();

/** True when Playwright resolves in the given tree (never throws). */
export async function playwrightAvailable(cwd?: string): Promise<boolean> {
  try {
    return (await loadPlaywright(cwd ?? process.cwd())) !== null;
  } catch {
    return false;
  }
}

/** Default opener: real Playwright persistent context on the channel profile. */
export const defaultContextOpener: ContextOpener = async ({ channel, headless, cwd }) => {
  const pw = (await loadPlaywright(cwd ?? process.cwd())) as unknown as PwModuleLike | null;
  if (!pw?.chromium || typeof pw.chromium.launchPersistentContext !== 'function') return null;
  const dir = profileDir(channel);
  await mkdir(dir, { recursive: true });
  // A headed login launched from a background process (Desktop IPC, OS
  // scheduler) can open BEHIND the active window — Windows foreground lock.
  // An explicit on-screen position/size makes the window impossible to miss.
  const launchOpts = headless
    ? { headless }
    : { headless, args: ['--window-position=100,80', '--window-size=1180,880'] };
  return adaptContext(await pw.chromium.launchPersistentContext(dir, launchOpts));
};

/** First entry of `entries` whose selector is present on `page` (or undefined). */
async function firstMatch(
  page: BrowserPageLike,
  entries: readonly { label: string; selector: string }[],
): Promise<string | undefined> {
  for (const e of entries) {
    if (await page.hasSelector(e.selector)) return e.label;
  }
  return undefined;
}

export interface CheckLoginDeps {
  opener?: ContextOpener;
  cwd?: string;
  navTimeoutMs?: number;
}

/**
 * Headless login-state check against the on-disk profile. Returns a
 * HealthReport; a technical failure (Playwright missing, launch/navigation
 * error) THROWS — so "not logged in" is never confused with "could not check".
 */
export async function checkLogin(channel: string, deps: CheckLoginDeps = {}): Promise<HealthReport> {
  if (!isSupportedChannel(channel)) {
    throw new Error(`unknown social channel: ${channel} (supported: ${SUPPORTED_CHANNELS.join(', ')})`);
  }
  const sel = await loadSelectors(channel);
  const ctx = await (deps.opener ?? defaultContextOpener)({ channel, headless: true, cwd: deps.cwd });
  if (!ctx) throw new Error(PLAYWRIGHT_UNAVAILABLE_HINT);
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(sel.loginUrl, {
      timeout: deps.navTimeoutMs ?? NAV_TIMEOUT_MS,
      waitUntil: 'domcontentloaded',
    });
    // PRIMARY signal — session cookies (locale-proof, A/B-proof). A profile
    // holding ALL the channel's auth cookies IS logged in, whatever the
    // (translated, shuffled) DOM renders. DOM chains remain the fallback for
    // channels without sessionCookies or contexts without cookie access.
    const wanted = sel.sessionCookies ?? [];
    if (wanted.length > 0 && typeof ctx.cookies === 'function') {
      const names = new Set((await ctx.cookies()).map((c) => c.name));
      if (wanted.every((n) => names.has(n))) {
        return {
          channel,
          loggedIn: true,
          matched: `cookies:${wanted.join('+')}`,
          checkedAt: nowIso(),
        };
      }
      const missing = wanted.filter((n) => !names.has(n));
      return {
        channel,
        loggedIn: false,
        matched: `cookies:missing ${missing.join('+')}`,
        checkedAt: nowIso(),
      };
    }
    const inHit = await firstMatch(page, sel.loggedIn);
    if (inHit) return { channel, loggedIn: true, matched: inHit, checkedAt: nowIso() };
    const outHit = await firstMatch(page, sel.loggedOut);
    return { channel, loggedIn: false, matched: outHit, checkedAt: nowIso() };
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

/**
 * Resolve as soon as the profile gains ALL wanted cookies (login detected —
 * the caller then closes the window), the context closes, or `timeoutMs`
 * elapses — whichever comes first.
 */
function waitForLoginCloseOrTimeout(
  ctx: PersistentContextLike,
  timeoutMs: number,
  loginDetected: () => Promise<boolean>,
  pollMs = 2_500,
): Promise<'login' | 'closed' | 'timeout'> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poller: ReturnType<typeof setInterval> | undefined;
    const done = (r: 'login' | 'closed' | 'timeout'): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (poller) clearInterval(poller);
      resolve(r);
    };
    timer = setTimeout(() => done('timeout'), timeoutMs);
    ctx.onClose(() => done('closed'));
    poller = setInterval(() => {
      void loginDetected()
        .then((hit) => {
          if (hit) done('login');
        })
        .catch(() => undefined);
    }, pollMs);
  });
}

export interface LoginSessionOptions {
  /** Max seconds to wait for the user to close the window (default 300). */
  timeoutSec?: number;
  opener?: ContextOpener;
  cwd?: string;
  /** Where the instructions go (default: stdout). */
  log?: (line: string) => void;
  navTimeoutMs?: number;
  /** Cookie-poll interval while the login window is open (default 2500ms). */
  loginPollMs?: number;
}

/**
 * Open a HEADED window on the persistent profile for a manual login, then
 * confirm headlessly. Returns { ok:false } (never throws) when the window closed
 * without a logged-in state — that is "unproven" (exit 4), not a technical error.
 */
export async function openLoginSession(
  channel: string,
  opts: LoginSessionOptions = {},
): Promise<LoginSessionResult> {
  if (!isSupportedChannel(channel)) {
    throw new Error(`unknown social channel: ${channel} (supported: ${SUPPORTED_CHANNELS.join(', ')})`);
  }
  const sel = await loadSelectors(channel);
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const opener = opts.opener ?? defaultContextOpener;
  const timeoutSec =
    opts.timeoutSec && opts.timeoutSec > 0 ? opts.timeoutSec : DEFAULT_LOGIN_TIMEOUT_SEC;

  const ctx = await opener({ channel, headless: false, cwd: opts.cwd });
  if (!ctx) throw new Error(PLAYWRIGHT_UNAVAILABLE_HINT);
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    log(`Opening ${sel.loginUrl} …`);
    log(
      `Log in to ${channel} manually, then close the window — or wait up to ${timeoutSec}s. ` +
        `The profile is saved under ${profileDir(channel)}. ` +
        `If you do not see the window, look for Chromium in the taskbar.`,
    );
    try {
      await page.goto(sel.loginUrl, {
        timeout: opts.navTimeoutMs ?? NAV_TIMEOUT_MS,
        waitUntil: 'domcontentloaded',
      });
    } catch (err) {
      log(
        `Could not navigate to ${sel.loginUrl} (${err instanceof Error ? err.message : String(err)}) — ` +
          'if the window stays blank, type the address in it manually.',
      );
    }
    // Best-effort foreground: raise the login window above the app that spawned
    // us (e.g. the Desktop Automations tab). Noop on pages without the method.
    if (typeof page.bringToFront === 'function') {
      await page.bringToFront().catch(() => undefined);
    }
    // Poll the profile cookies WHILE the window is open: the moment all the
    // channel's auth cookies land, the login is detected and the window closes
    // itself — no guessing about when the user is done.
    const wanted = sel.sessionCookies ?? [];
    const cookieCheck = async (): Promise<boolean> => {
      if (wanted.length === 0 || typeof ctx.cookies !== 'function') return false;
      const names = new Set((await ctx.cookies()).map((c) => c.name));
      return wanted.every((n) => names.has(n));
    };
    const outcome = await waitForLoginCloseOrTimeout(
      ctx,
      timeoutSec * 1000,
      cookieCheck,
      opts.loginPollMs,
    );
    if (outcome === 'login') {
      log('Login detected (session cookies present) — closing the window…');
    } else {
      log(outcome === 'closed' ? 'Window closed — verifying login…' : 'Timed out — verifying login…');
    }
  } finally {
    await ctx.close().catch(() => undefined);
  }

  const health = await checkLogin(channel, { opener, cwd: opts.cwd, navTimeoutMs: opts.navTimeoutMs });
  if (health.loggedIn) return { ok: true, loginUrl: sel.loginUrl, loggedIn: true };
  return {
    ok: false,
    loggedIn: false,
    loginUrl: sel.loginUrl,
    reason:
      `no logged-in state detected — the profile lacks ${sel.sessionCookies?.join('+') ?? 'a login'}` +
      (health.matched ? ` (${health.matched})` : '') +
      ` — re-run \`automation login ${channel}\` and complete the login in the window`,
  };
}
