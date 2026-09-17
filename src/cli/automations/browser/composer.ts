/**
 * automations/browser/composer.ts — the x.com composer flow (F3.2).
 *
 * The step-by-step mechanics of publishing one approved draft on the X web
 * composer, driven entirely through the BrowserPageLike seam (selectors come
 * from selectors/<channel>.json fallback chains — nothing is hardcoded but the
 * trivial URLs):
 *
 *   openComposer → typeHumanLike → (media) → click Post → extractPermalink → screenshot
 *
 * Every failing step throws a typed PublishStepError carrying the STEP NAME so
 * probe/UX can say exactly what broke. Playwright is never imported here.
 *
 * The channel-agnostic mechanics (typing, selector chains, evidence, page
 * surface) live in ./humanInput.ts and the typed errors in ./errors.ts; both are
 * re-exported here so existing importers keep one entry point.
 */
import type { ChannelPublishInput, ChannelPublishResult } from '../channels/types.js';
import { PublishStepError } from './errors.js';
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

export * from './errors.js';
export * from './humanInput.js';

/** Trivial URL constants only — everything else is selector-driven. */
export const HOME_URL = 'https://x.com/home';
export const COMPOSE_URL = 'https://x.com/compose/post';
/** Generous, step-specific timeouts (ms). */
export const COMPOSER_TIMEOUT_MS = 10_000;
export const BUTTON_TIMEOUT_MS = 10_000;
export const TOAST_TIMEOUT_MS = 15_000;
export const PROFILE_TIMEOUT_MS = 15_000;
export const MEDIA_TIMEOUT_MS = 3_000;
/** Chars of the posted text used to locate it on the profile (fallback). */
export const PERMALINK_NEEDLE_CHARS = 40;
/** Evidence screenshot filename under runs/<automationId>/<runId>/. */
export const EVIDENCE_FILE = 'evidence-x.png';

/**
 * Open the composer and return the matched textbox selector. Prefers the direct
 * /compose/post URL, then falls back to the home timeline → compose-entry click.
 */
export async function openComposer(page: BrowserPageLike, sel: ChannelSelectors): Promise<string> {
  const pub = sel.publish;
  if (!pub) throw new PublishStepError('composer-open', 'selectors file has no publish section');
  await page
    .goto(COMPOSE_URL, { timeout: COMPOSER_TIMEOUT_MS, waitUntil: 'domcontentloaded' })
    .catch(() => undefined);
  const direct = await firstSelectorOptional(page, pub.textbox, COMPOSER_TIMEOUT_MS);
  if (direct) return direct;

  await page
    .goto(HOME_URL, { timeout: COMPOSER_TIMEOUT_MS, waitUntil: 'domcontentloaded' })
    .catch(() => undefined);
  const entry = await firstSelector(page, pub.composeEntry ?? [], 'composer-open', COMPOSER_TIMEOUT_MS);
  await (page as ComposerPage).click(entry, { timeout: COMPOSER_TIMEOUT_MS });
  const afterClick = await firstSelectorOptional(page, pub.textbox, COMPOSER_TIMEOUT_MS);
  if (!afterClick) {
    throw new PublishStepError('composer-textbox', 'composer textbox not found after opening');
  }
  return afterClick;
}

/** Parse an X status href into {postId,url}. Throws (never fabricates) on junk. */
export function toPermalink(href: string, step: string): { postId: string; url: string } {
  let url: string;
  try {
    url = new URL(href, 'https://x.com').href;
  } catch {
    throw new PublishStepError(step, `malformed permalink href: ${href}`);
  }
  const m = /\/status\/(\d+)/.exec(url);
  if (!m) throw new PublishStepError(step, `no status id in href: ${href}`);
  return { postId: m[1], url };
}

/** First absolute /status/ href from a fallback chain (undefined when none). */
async function firstStatusHref(
  page: ComposerPage,
  chain: readonly SelectorEntry[],
  timeoutMs: number,
): Promise<string | undefined> {
  for (const e of chain) {
    if (!(await page.hasSelector(e.selector, timeoutMs))) continue;
    const hrefs = await page.hrefs(e.selector);
    const hit = hrefs.find((h) => h.includes('/status/'));
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
  const toast = await firstStatusHref(page, pub.toastView ?? [], TOAST_TIMEOUT_MS);
  if (toast) return toPermalink(toast, 'post-toast');

  const link = await firstSelectorOptional(page, pub.profileLink ?? [], PROFILE_TIMEOUT_MS);
  if (link) {
    await page.click(link, { timeout: PROFILE_TIMEOUT_MS }).catch(() => undefined);
  } else {
    await page
      .goto(HOME_URL, { timeout: PROFILE_TIMEOUT_MS, waitUntil: 'domcontentloaded' })
      .catch(() => undefined);
  }
  const needle = text.slice(0, PERMALINK_NEEDLE_CHARS);
  for (const e of pub.profilePost ?? []) {
    if (!(await page.hasSelector(e.selector, PROFILE_TIMEOUT_MS))) continue;
    const links = await page.linkTexts(e.selector);
    const match = links.find(
      (l) => l.href.includes('/status/') && (needle.length === 0 || l.text.includes(needle)),
    );
    if (match) return toPermalink(match.href, 'profile-search');
  }
  throw new PublishStepError('post-toast', 'permalink not found (toast + profile search failed)');
}

/**
 * Drive the composer end-to-end (steps 2-6 of a publish): open, type, media,
 * Post, permalink, evidence. A missing media selector WARNS, never aborts.
 */
export async function runComposerPublish(
  page: ComposerPage,
  sel: ChannelSelectors,
  input: ChannelPublishInput,
  opts: ComposerRunOptions,
): Promise<ChannelPublishResult> {
  const warnings: string[] = [];

  const textbox = await openComposer(page, sel);
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

  const postButton = await firstSelector(
    page,
    sel.publish?.postButton ?? [],
    'post-button',
    BUTTON_TIMEOUT_MS,
  );
  await page.click(postButton, { timeout: BUTTON_TIMEOUT_MS });
  const permalink = await extractPermalink(page, sel, input.text);

  let screenshotPath: string | undefined;
  try {
    screenshotPath = await captureEvidence(page, opts.cwd, opts.automationId, opts.runId, EVIDENCE_FILE);
  } catch (e) {
    warnings.push(`evidence screenshot failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { postId: permalink.postId, url: permalink.url, dryRun: false, screenshotPath, warnings };
}
