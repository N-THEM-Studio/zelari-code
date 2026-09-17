/**
 * automations/browser/fbComposer.ts — the facebook.com composer flow (F3.3).
 *
 * Same shape as the X composer (./composer.ts) but for Facebook: the shared step
 * mechanics live in ./humanInput.ts and the typed errors in ./errors.ts, so this
 * module only holds the Facebook-specific URLs and permalink grammar.
 *
 *   openComposer → typeHumanLike → (media) → click Post → extractPermalink → screenshot
 *
 * Permalinks are ALWAYS extracted from the DOM/URL — never fabricated (P1). The
 * accepted shapes are `/<page>/posts/<digits>`, `/share/p/<token>` and
 * `permalink.php?story_fbid=<digits>&id=<digits>`; `fb.watch` links are rejected.
 * The health gate lives in ./fbPublisher.ts (before ANY interaction).
 */
import type { ChannelPublishInput, ChannelPublishResult } from '../channels/types.js';
import { PublishStepError, ReloginRequiredError } from './errors.js';
import {
  captureEvidence,
  firstSelector,
  firstSelectorOptional,
  type ComposerPage,
  type ComposerRunOptions,
  typeHumanLike,
} from './humanInput.js';
import type { BrowserPageLike } from './pageAdapter.js';
import type { ChannelSelectors, SelectorEntry } from './selectors.js';

/** Re-export the shared typed errors (uniform surface with ./composer.ts). */
export * from './errors.js';

/** Trivial URL constants only — everything else is selector-driven. */
export const FB_HOME_URL = 'https://www.facebook.com/';
/** Generous, step-specific timeouts (ms). */
export const COMPOSER_TIMEOUT_MS = 10_000;
export const BUTTON_TIMEOUT_MS = 10_000;
export const TOAST_TIMEOUT_MS = 2_000;
export const PROFILE_TIMEOUT_MS = 8_000;
export const MEDIA_TIMEOUT_MS = 3_000;
/** Per-entry probe budgets for the cheap pre-composer gates (absent ⇒ burn). */
export const CONSENT_PROBE_MS = 500;
/** Settle pause after dismissing the GDPR cookie wall (only when clicked). */
export const CONSENT_SETTLE_MS = 1_200;
/** Per-entry probe budget for the logged-out markers (absent ⇒ burn). */
export const LOGGEDOUT_PROBE_MS = 300;
/** Chars of the posted text used to locate it on the page/profile (fallback). */
export const PERMALINK_NEEDLE_CHARS = 40;
/** Evidence screenshot filename under runs/<automationId>/<runId>/. */
export const EVIDENCE_FILE = 'evidence-facebook.png';

/** Accepted permalink shapes. All EXTRACTED from the DOM/URL — never fabricated. */
const PERMALINK_PHP_RE = /permalink\.php\?(?:[^#]*&)?story_fbid=(\d+)/;
const STORY_RE = /story\.php\?(?:[^#]*&)?story_fbid=(\d+)/;
const SHARE_RE = /\/share\/p\/([A-Za-z0-9_-]+)/;
const POSTS_RE = /\/posts\/(\d+)/;
/** Own-profile URL: redirects to the logged user's profile (username or id). */
export const FB_PROFILE_ME_URL = 'https://www.facebook.com/me';

/**
 * Parse a Facebook href into {postId,url}. Accepts ONLY:
 *   - permalink.php?story_fbid=<digits>&id=<digits>
 *   - /<page>/posts/<digits>  (also /groups/<g>/posts/<digits>)
 *   - /share/p/<token>
 * `fb.watch` short links are explicitly rejected. Throws on anything else.
 */
export function toFacebookPermalink(href: string, step: string): { postId: string; url: string } {
  let url: string;
  try {
    url = new URL(href, 'https://www.facebook.com').href;
  } catch {
    throw new PublishStepError(step, `malformed permalink href: ${href}`);
  }
  if (/(^|\/\/)([^/]*\.)?fb\.watch(\/|$)/.test(url)) {
    throw new PublishStepError(step, `fb.watch links are not accepted as permalinks: ${href}`);
  }
  const story = STORY_RE.exec(url);
  if (story) return { postId: story[1], url };
  const php = PERMALINK_PHP_RE.exec(url);
  if (php) return { postId: php[1], url };
  const share = SHARE_RE.exec(url);
  if (share) return { postId: share[1], url };
  const posts = POSTS_RE.exec(url);
  if (posts) return { postId: posts[1], url };
  throw new PublishStepError(step, `no facebook permalink in href: ${href}`);
}

/** True when `href` is one of the accepted Facebook permalink shapes. */
export function isFacebookPermalink(href: string): boolean {
  try {
    toFacebookPermalink(href, 'check');
    return true;
  } catch {
    return false;
  }
}

/** Optional composer entry options (page URL configurable; default = home feed). */
export interface FacebookOpenOptions {
  /** Page/landing URL to open the composer from (else the home feed). */
  pageUrl?: string;
}

/**
 * Open the Facebook composer and return the matched textbox selector. Navigates
 * to `pageUrl` (a Page) when given, else the home feed — the base flow works on
 * a personal profile too — then falls back to clicking the "Create a post" entry
 * when no textbox renders directly.
 */
export async function openComposer(
  page: BrowserPageLike,
  sel: ChannelSelectors,
  opts: FacebookOpenOptions = {},
): Promise<string> {
  const pub = sel.publish;
  if (!pub) throw new PublishStepError('composer-open', 'selectors file has no publish section');
  const startUrl = opts.pageUrl && opts.pageUrl.length > 0 ? opts.pageUrl : FB_HOME_URL;
  await page
    .goto(startUrl, { timeout: COMPOSER_TIMEOUT_MS, waitUntil: 'domcontentloaded' })
    .catch(() => undefined);
  // GDPR cookie wall first: on EU accounts it covers the feed, and every
  // downstream selector would miss while it is up. Best-effort — this accepts
  // the same consent the user already gave in the headed login session.
  for (const e of sel.consentButtons ?? []) {
    if (await page.hasSelector(e.selector, CONSENT_PROBE_MS)) {
      await (page as ComposerPage).click(e.selector, { timeout: BUTTON_TIMEOUT_MS }).catch(
        () => undefined,
      );
      await new Promise((resolve) => setTimeout(resolve, CONSENT_SETTLE_MS));
      break;
    }
  }
  // Server-side session rejection: cookies passed the local gate but the
  // server answered with the logged-out page (seen live: only the login
  // button + cookie wall render). Stop BEFORE any click or typing.
  for (const e of pub.loggedOutMarkers ?? []) {
    if (await page.hasSelector(e.selector, LOGGEDOUT_PROBE_MS)) {
      throw new ReloginRequiredError(
        `facebook session rejected by the server after navigation (${e.label} present on ${startUrl}) — run \`zelari-code automation login facebook\``,
      );
    }
  }
  const direct = await firstSelectorOptional(page, pub.textbox, COMPOSER_TIMEOUT_MS);
  if (direct) return direct;

  const entry = await firstSelector(page, pub.composeEntry ?? [], 'composer-open', COMPOSER_TIMEOUT_MS);
  await (page as ComposerPage).click(entry, { timeout: COMPOSER_TIMEOUT_MS });
  const afterClick = await firstSelectorOptional(page, pub.textbox, COMPOSER_TIMEOUT_MS);
  if (!afterClick) {
    throw new PublishStepError('composer-textbox', 'composer textbox not found after opening');
  }
  return afterClick;
}

/** First accepted Facebook permalink href from a fallback chain. */
async function firstFacebookHref(
  page: ComposerPage,
  chain: readonly SelectorEntry[],
  timeoutMs: number,
): Promise<string | undefined> {
  for (const e of chain) {
    if (!(await page.hasSelector(e.selector, timeoutMs))) continue;
    const hrefs = await page.hrefs(e.selector);
    const hit = hrefs.find((h) => isFacebookPermalink(h));
    if (hit) return hit;
  }
  return undefined;
}

/** PRIMARY toast → FALLBACK profile-search. Throws 'post-toast' when both fail. */
async function extractPermalink(
  page: ComposerPage,
  sel: ChannelSelectors,
  text: string,
): Promise<{ postId: string; url: string }> {
  const pub = sel.publish;
  if (!pub) throw new PublishStepError('post-toast', 'selectors file has no publish section');
  const toast = await firstFacebookHref(page, pub.toastView ?? [], TOAST_TIMEOUT_MS);
  if (toast) return toFacebookPermalink(toast, 'post-toast');

  const needle = text.slice(0, PERMALINK_NEEDLE_CHARS);
  const scanArticles = async (): Promise<{ postId: string; url: string } | undefined> => {
    await page
      .goto(FB_PROFILE_ME_URL, { timeout: PROFILE_TIMEOUT_MS, waitUntil: 'domcontentloaded' })
      .catch(() => undefined);
    if (page.articlePermalinks && needle.length > 0) {
      const arts = await page.articlePermalinks();
      const hit = arts.find((a) => a.href.length > 0 && a.text.includes(needle));
      if (hit) return toFacebookPermalink(hit.href, 'profile-search');
    }
    return undefined;
  };
  const firstScan = await scanArticles();
  if (firstScan) return firstScan;
  await new Promise((r) => setTimeout(r, 1_500));
  const retryScan = await scanArticles();
  if (retryScan) return retryScan;
  // Secondary scan: legacy selector chains on the landed page.
  for (const e of pub.profilePost ?? []) {
    if (!(await page.hasSelector(e.selector, PROFILE_TIMEOUT_MS))) continue;
    const links = await page.linkTexts(e.selector);
    const match = links.find(
      (l) => isFacebookPermalink(l.href) && (needle.length === 0 || l.text.includes(needle)),
    );
    if (match) return toFacebookPermalink(match.href, 'profile-search');
  }
  throw new PublishStepError('post-toast', 'permalink not found (toast + profile search failed)');
}

/** Runtime knobs for one Facebook composer run (adds the optional page URL). */
export interface FacebookComposerRunOptions extends ComposerRunOptions {
  pageUrl?: string;
}

/** Per-entry probe budget for the post-button chain (a miss must be fast). */
export const POST_BUTTON_PROBE_MS = 800;
/** Settle pause after an "Avanti/Next" advance before re-probing the post button. */
export const ADVANCE_SETTLE_MS = 1_500;
/** Brief pause after clicking Post so the toast/dialog can settle. */
export const POST_SETTLE_MS = 1_200;
/** Exact-text fallback labels for the final dialog button (code-side, last resort). */
export const POST_TEXT_FALLBACK = [
  'Pubblica',
  'Pubblica ora',
  'Post',
  'Publish',
  'Publier',
  'Publicar',
  'Posten',
] as const;
export const ADVANCE_TEXT_FALLBACK = ['Avanti', 'Next', 'Siguiente', 'Suivant', 'Weiter'] as const;
/**
 * Composer chrome (Avanti/Pubblica) is a SIBLING of `[role=dialog]`, not a
 * descendant — live dump 2026-09-17: dialog is only the 500×60 header.
 */
export const COMPOSER_BUTTON_SCOPE = "[role='button'], button";

/**
 * Click the composer's final button, walking Facebook's multi-step flow:
 * exact post button → (absent) advance "Avanti/Next" → retry post button →
 * exact TEXT match inside the dialog (in-page click: immune to overlay
 * interception and to substring traps like the feed's "Azioni per questo
 * post"). Throws 'post-button' only when every strategy missed.
 */
/** Short fail-soft click: hidden matches must not burn 10s. */
async function clickIfVisible(page: ComposerPage, selector: string): Promise<boolean> {
  try {
    await page.click(selector, { timeout: POST_BUTTON_PROBE_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * OpenBot-style: click by visible exact accessible name FIRST (role/text), CSS
 * last. Substring CSS was matching feed toasts ("pubblicato") and never submitting.
 */
async function clickPostButton(page: ComposerPage, sel: ChannelSelectors): Promise<void> {
  const pub = sel.publish;
  if (!pub) throw new PublishStepError('post-button', 'selectors file has no publish section');
  const pageLike = page as unknown as BrowserPageLike;
  const byText = typeof pageLike.clickText === 'function' ? pageLike.clickText.bind(pageLike) : null;

  if (byText && (await byText(COMPOSER_BUTTON_SCOPE, POST_TEXT_FALLBACK))) return;

  const direct = await firstSelectorOptional(page, pub.postButton ?? [], POST_BUTTON_PROBE_MS);
  if (direct && (await clickIfVisible(page, direct))) return;

  if (byText && (await byText(COMPOSER_BUTTON_SCOPE, ADVANCE_TEXT_FALLBACK))) {
    await new Promise((r) => setTimeout(r, ADVANCE_SETTLE_MS));
    if (await byText(COMPOSER_BUTTON_SCOPE, POST_TEXT_FALLBACK)) return;
  }

  const advance = await firstSelectorOptional(page, pub.advanceButtons ?? [], MEDIA_TIMEOUT_MS);
  if (advance && (await clickIfVisible(page, advance))) {
    await new Promise((r) => setTimeout(r, ADVANCE_SETTLE_MS));
    if (byText && (await byText(COMPOSER_BUTTON_SCOPE, POST_TEXT_FALLBACK))) return;
    const afterAdvance = await firstSelectorOptional(page, pub.postButton ?? [], POST_BUTTON_PROBE_MS);
    if (afterAdvance && (await clickIfVisible(page, afterAdvance))) return;
  }

  throw new PublishStepError(
    'post-button',
    `post button not found: visible labels (${POST_TEXT_FALLBACK.join('/')}) and CSS all missed`,
  );
}

/**
 * Drive the Facebook composer end-to-end: open, type, media, Post, permalink,
 * evidence. A missing media selector WARNS, never aborts.
 */
export async function runFacebookComposerPublish(
  page: ComposerPage,
  sel: ChannelSelectors,
  input: ChannelPublishInput,
  opts: FacebookComposerRunOptions,
): Promise<ChannelPublishResult> {
  const warnings: string[] = [];

  const textbox = await openComposer(page, sel, { pageUrl: opts.pageUrl });
  await typeHumanLike(page, textbox, input.text, opts.delayMs, opts.sleep);

  const mediaPaths = input.mediaPaths ?? [];
  if (mediaPaths.length > 0) {
    const fileInput = await firstSelectorOptional(page, sel.publish?.fileInput ?? [], MEDIA_TIMEOUT_MS);
    if (fileInput && typeof page.setInputFiles === 'function') {
      await page.setInputFiles(fileInput, mediaPaths);
    } else {
      warnings.push('media selector missing — posted text-only');
    }
  }

  await clickPostButton(page, sel);
  await new Promise((r) => setTimeout(r, POST_SETTLE_MS));
  const permalink = await extractPermalink(page, sel, input.text);

  let screenshotPath: string | undefined;
  try {
    screenshotPath = await captureEvidence(page, opts.cwd, opts.automationId, opts.runId, EVIDENCE_FILE);
  } catch (e) {
    warnings.push(`evidence screenshot failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { postId: permalink.postId, url: permalink.url, dryRun: false, screenshotPath, warnings };
}
