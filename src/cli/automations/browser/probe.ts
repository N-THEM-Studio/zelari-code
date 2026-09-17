/**
 * automations/browser/probe.ts — headless selector diagnostic (F3.1).
 *
 * Answers, step by step, "why is my channel session not working?" without
 * needing a rebuild: is Playwright present, does the profile exist, does the
 * login URL load, and — crucially — which selector (if any) matched. Every
 * step carries `ok` + a human `detail`, so a stale selector is obvious.
 *
 * `ok` on the whole report ⇔ every step is ok (the CLI maps that to exit 0/1).
 * The DB of selectors is JSON, so the fix for a broken selector is an edit, not
 * a release.
 */
import { existsSync } from 'node:fs';
import {
  defaultContextOpener,
  NAV_TIMEOUT_MS,
  PLAYWRIGHT_UNAVAILABLE_HINT,
  playwrightAvailable,
  profileDir,
  type BrowserPageLike,
  type ContextOpener,
  type PersistentContextLike,
} from './session.js';
import { isSupportedChannel, loadSelectors, SUPPORTED_CHANNELS, type ChannelSelectors } from './selectors.js';
import { openComposer as openFacebookComposer } from './fbComposer.js';
import {
  BUTTON_TIMEOUT_MS,
  firstSelector,
  openComposer as openXComposer,
  toComposerPage,
  type ComposerPage,
} from './publisher.js';

/**
 * Per-channel composer openers (F3.2 X, F3.3 Facebook). Each opens the composer
 * and returns the matched textbox selector; the post-button step is generic
 * (driven by the channel's own `publish.postButton` chain).
 */
const COMPOSER_OPENERS: Record<
  string,
  (page: BrowserPageLike, sel: ChannelSelectors) => Promise<string>
> = {
  x: openXComposer,
  facebook: openFacebookComposer,
};

/** One diagnostic step. `detail` names the selector/label that decided it. */
export interface ProbeStep {
  step: string;
  ok: boolean;
  detail?: string;
}

/** The full probe outcome. `ok` ⇔ every step ok. */
export interface ProbeReport {
  channel: string;
  ok: boolean;
  checkedAt: string;
  steps: ProbeStep[];
}

export interface ProbeDeps {
  opener?: ContextOpener;
  /** Presence check for Playwright (default: real loader). */
  available?: (cwd?: string) => Promise<boolean>;
  /** Profile-directory check (default: real fs). Overridable for tests. */
  profileExists?: (channel: string) => boolean;
  cwd?: string;
  navTimeoutMs?: number;
  /** add the composer-open + post-button diagnostic steps (F3.2). */
  publish?: boolean;
}

/** Append the two --publish steps as "skipped" (browser/login unavailable). */
function skipComposer(steps: ProbeStep[], detail: string): void {
  steps.push({ step: 'composer-open', ok: false, detail });
  steps.push({ step: 'post-button', ok: false, detail });
}

/**
 * --publish: open the composer (type NOTHING), verify the Post button, Escape.
 * Kept non-destructive: no text is ever typed and nothing is ever posted.
 */
async function appendComposerProbe(
  steps: ProbeStep[],
  page: BrowserPageLike,
  sel: ChannelSelectors,
  openComposerFn: (page: BrowserPageLike, sel: ChannelSelectors) => Promise<string>,
): Promise<void> {
  if (!sel.publish) {
    skipComposer(steps, 'selectors file has no publish section (add one to selectors/<channel>.json)');
    return;
  }
  let cp: ComposerPage;
  try {
    cp = toComposerPage(page);
  } catch (e) {
    skipComposer(steps, e instanceof Error ? e.message : String(e));
    return;
  }
  try {
    const textbox = await openComposerFn(page, sel);
    await cp.press('Escape').catch(() => undefined);
    steps.push({ step: 'composer-open', ok: true, detail: `textbox present (${textbox})` });
  } catch (e) {
    steps.push({ step: 'composer-open', ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
  try {
    await openComposerFn(page, sel);
    const button = await firstSelector(page, sel.publish.postButton, 'post-button', BUTTON_TIMEOUT_MS);
    steps.push({ step: 'post-button', ok: true, detail: `button present (${button})` });
  } catch (e) {
    steps.push({ step: 'post-button', ok: false, detail: e instanceof Error ? e.message : String(e) });
  } finally {
    await cp.press('Escape').catch(() => undefined);
  }
}

function report(channel: string, steps: ProbeStep[]): ProbeReport {
  return {
    channel,
    ok: steps.every((s) => s.ok),
    checkedAt: new Date().toISOString(),
    steps,
  };
}

/** Classify the loaded page: logged-in, logged-out, or "no selector matched". */
async function loginStateStep(page: BrowserPageLike, sel: ChannelSelectors): Promise<ProbeStep> {
  for (const e of sel.loggedIn) {
    if (await page.hasSelector(e.selector)) {
      return { step: 'login-state', ok: true, detail: `logged-in via ${e.label}` };
    }
  }
  for (const e of sel.loggedOut) {
    if (await page.hasSelector(e.selector)) {
      return { step: 'login-state', ok: true, detail: `logged-out via ${e.label}` };
    }
  }
  return {
    step: 'login-state',
    ok: false,
    detail: 'no selector matched — selectors may be stale (edit selectors/<channel>.json)',
  };
}

/** Run the 4-step diagnostic. Throws only for an unknown channel / bad selectors. */
export async function runProbe(channel: string, deps: ProbeDeps = {}): Promise<ProbeReport> {
  if (!isSupportedChannel(channel)) {
    throw new Error(`unknown social channel: ${channel} (supported: ${SUPPORTED_CHANNELS.join(', ')})`);
  }
  const sel = await loadSelectors(channel);
  const available = deps.available ?? playwrightAvailable;
  const opener = deps.opener ?? defaultContextOpener;
  const profileExists = deps.profileExists ?? ((ch: string) => existsSync(profileDir(ch)));
  const steps: ProbeStep[] = [];

  const hasBrowser = await available(deps.cwd);
  steps.push({
    step: 'browser-available',
    ok: hasBrowser,
    detail: hasBrowser ? undefined : PLAYWRIGHT_UNAVAILABLE_HINT,
  });

  const profile = profileDir(channel);
  const hasProfile = profileExists(channel);
  steps.push({
    step: 'profile-exists',
    ok: hasProfile,
    detail: hasProfile ? profile : `not found — run: zelari-code automation login ${channel}`,
  });

  if (!hasBrowser) {
    steps.push({ step: 'goto-login', ok: false, detail: 'skipped (browser unavailable)' });
    steps.push({ step: 'login-state', ok: false, detail: 'skipped (browser unavailable)' });
    if (deps.publish) skipComposer(steps, 'skipped (browser unavailable)');
    return report(channel, steps);
  }

  let ctx: PersistentContextLike | null = null;
  try {
    ctx = await opener({ channel, headless: true, cwd: deps.cwd });
    if (!ctx) throw new Error(PLAYWRIGHT_UNAVAILABLE_HINT);
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    try {
      await page.goto(sel.loginUrl, {
        timeout: deps.navTimeoutMs ?? NAV_TIMEOUT_MS,
        waitUntil: 'domcontentloaded',
      });
      steps.push({ step: 'goto-login', ok: true, detail: page.url?.() ?? sel.loginUrl });
      steps.push(await loginStateStep(page, sel));
      if (deps.publish) {
        const openerFn = COMPOSER_OPENERS[channel];
        if (openerFn) await appendComposerProbe(steps, page, sel, openerFn);
        else skipComposer(steps, `no composer flow for channel: ${channel}`);
      }
    } catch (e) {
      steps.push({ step: 'goto-login', ok: false, detail: e instanceof Error ? e.message : String(e) });
      steps.push({ step: 'login-state', ok: false, detail: 'skipped (navigation failed)' });
      if (deps.publish) skipComposer(steps, 'skipped (navigation failed)');
    }
  } catch (e) {
    steps.push({ step: 'goto-login', ok: false, detail: e instanceof Error ? e.message : String(e) });
    steps.push({ step: 'login-state', ok: false, detail: 'skipped (browser launch failed)' });
    if (deps.publish) skipComposer(steps, 'skipped (browser launch failed)');
  } finally {
    if (ctx) await ctx.close().catch(() => undefined);
  }
  return report(channel, steps);
}

/** Render a ProbeReport as a short, readable block (one line per step). */
export function formatProbeReport(r: ProbeReport): string {
  const head = `probe ${r.channel} — ${r.ok ? 'OK' : 'FAILED'} (${r.checkedAt})`;
  const lines = r.steps.map(
    (s) => `  [${s.ok ? 'ok' : 'x'}] ${s.step}${s.detail ? ` — ${s.detail}` : ''}`,
  );
  return [head, ...lines].join('\n');
}
