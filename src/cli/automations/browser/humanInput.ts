/**
 * automations/browser/humanInput.ts — channel-agnostic composer step mechanics
 * (F3.2 extracted in F3.3 so X and Facebook share one implementation).
 *
 * Everything here is expressed through the BrowserPageLike seam: the composer
 * page surface, selector-chain resolution, human-like typing, evidence
 * screenshots and the generic runtime knobs. It contains NO channel-specific
 * URLs or permalink grammar — those live in ./composer.ts (X) and
 * ./fbComposer.ts (Facebook). Playwright is never imported.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PublishStepError } from './errors.js';
import type { SelectorEntry } from './selectors.js';
import type { BrowserPageLike } from './pageAdapter.js';

/** Human typing cadence range (ms per char). */
export const CHAR_DELAY_MIN_MS = 30;
export const CHAR_DELAY_MAX_MS = 80;

/** Opt-in headless (Facebook/X detect automation and skip the real composer). */
export const HEADLESS_ENV = 'ZELARI_BROWSER_HEADLESS';
/** Legacy alias: ZELARI_BROWSER_HEADED=1 also forces headed. */
export const HEADED_ENV = 'ZELARI_BROWSER_HEADED';

/**
 * Social publish defaults to HEADED (OpenBot-style persist window). Headless
 * is opt-in via ZELARI_BROWSER_HEADLESS=1 — FB/X often no-op the submit there.
 */
export function resolveHeadless(deps: { headless?: boolean }): boolean {
  if (deps.headless !== undefined) return deps.headless;
  if (process.env[HEADLESS_ENV] === '1') return true;
  if (process.env[HEADED_ENV] === '1') return false;
  return false;
}

/** Richer page surface every composer needs (the real adapter always provides it). */
export interface ComposerPage extends BrowserPageLike {
  click(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  typeText(selector: string, text: string, opts?: { delayMs?: number }): Promise<unknown>;
  press(key: string): Promise<unknown>;
  screenshot(path: string): Promise<unknown>;
  hrefs(selector: string): Promise<string[]>;
  linkTexts(selector: string): Promise<Array<{ href: string; text: string }>>;
  setInputFiles?(selector: string, files: string[]): Promise<unknown>;
}

/** Narrow a BrowserPageLike to the composer surface, or throw a step error. */
export function toComposerPage(page: BrowserPageLike): ComposerPage {
  const p = page as ComposerPage;
  if (
    typeof page.goto !== 'function' ||
    typeof page.hasSelector !== 'function' ||
    typeof p.click !== 'function' ||
    typeof p.typeText !== 'function' ||
    typeof p.press !== 'function' ||
    typeof p.screenshot !== 'function' ||
    typeof p.hrefs !== 'function' ||
    typeof p.linkTexts !== 'function'
  ) {
    throw new PublishStepError('composer-open', 'page lacks the composer surface');
  }
  return p;
}

/** Production per-char delay: uniform in [30, 80] ms. */
export function defaultCharDelayMs(): number {
  const span = CHAR_DELAY_MAX_MS - CHAR_DELAY_MIN_MS + 1;
  return CHAR_DELAY_MIN_MS + Math.floor(Math.random() * span);
}

export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** First selector in a fallback chain that is present; throws when none match. */
export async function firstSelector(
  page: BrowserPageLike,
  chain: readonly SelectorEntry[],
  step: string,
  timeoutMs: number,
): Promise<string> {
  for (const e of chain) {
    if (await page.hasSelector(e.selector, timeoutMs)) return e.selector;
  }
  const labels = chain.map((e) => e.label).join(', ') || '(empty chain)';
  throw new PublishStepError(step, `no selector matched (tried: ${labels})`);
}

/** Like firstSelector but returns undefined instead of throwing. */
export async function firstSelectorOptional(
  page: BrowserPageLike,
  chain: readonly SelectorEntry[],
  timeoutMs: number,
): Promise<string | undefined> {
  for (const e of chain) {
    if (await page.hasSelector(e.selector, timeoutMs)) return e.selector;
  }
  return undefined;
}

/** Type `text` one char at a time, sleeping `delayMs()` between keystrokes. */
export async function typeHumanLike(
  page: ComposerPage,
  selector: string,
  text: string,
  delayMs: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  for (const ch of text) {
    await page.typeText(selector, ch, { delayMs: 0 });
    const d = delayMs();
    if (d > 0) await sleep(d);
  }
}

/** Screenshot the current page into runs/<automationId>/<runId>/<fileName>. */
export async function captureEvidence(
  page: ComposerPage,
  cwd: string,
  automationId: string,
  runId: string,
  fileName: string,
): Promise<string> {
  const rel = path.join('.zelari', 'automations', 'runs', automationId, runId, fileName);
  const abs = path.join(cwd, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await page.screenshot(abs);
  return rel;
}

/** Runtime knobs for one composer run (channel-agnostic). */
export interface ComposerRunOptions {
  cwd: string;
  automationId: string;
  runId: string;
  delayMs: () => number;
  sleep: (ms: number) => Promise<void>;
}
