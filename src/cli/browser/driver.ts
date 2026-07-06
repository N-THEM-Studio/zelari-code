/**
 * browser/driver — drive a headless browser to verify web changes.
 *
 * The "visual verification loop" for web projects: after the agent edits a UI,
 * it navigates the running app and gets back the signals an LLM can actually
 * act on — console errors, uncaught page exceptions, failed network requests,
 * the final title/URL, whether an expected selector is present, and a saved
 * screenshot path. Far stronger than "the tests pass" for front-end work.
 *
 * Playwright is an OPTIONAL dependency, loaded via dynamic import so it is not
 * a hard requirement of the package. When it (or a browser) isn't available,
 * the tool degrades with a clear message. The loader is injectable, so the
 * driver's orchestration is unit-testable with a fake browser.
 */

export type BrowserAction =
  | { type: 'click'; selector: string }
  | { type: 'fill'; selector: string; value: string }
  | { type: 'wait'; ms: number }
  | { type: 'goto'; url: string };

export interface BrowserCheckOptions {
  url: string;
  actions?: BrowserAction[];
  /** Assert this selector is present after actions run. */
  waitForSelector?: string;
  /** Where to save the screenshot (PNG). */
  screenshotPath?: string;
  /** Overall navigation timeout (ms, default 15000). */
  timeoutMs?: number;
}

export interface BrowserCheckResult {
  ok: boolean;
  error?: string;
  title?: string;
  url?: string;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  screenshotPath?: string;
  /** Present only when `waitForSelector` was requested. */
  selectorFound?: boolean;
}

// --- Minimal structural surface of the Playwright API we use ---------------
// Kept intentionally loose (no dependency on playwright's types).

interface PageLike {
  on(event: 'console', cb: (msg: { type(): string; text(): string }) => void): void;
  on(event: 'pageerror', cb: (err: Error) => void): void;
  on(event: 'requestfailed', cb: (req: { url(): string; failure(): { errorText: string } | null }) => void): void;
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  click(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  fill(selector: string, value: string, opts?: { timeout?: number }): Promise<unknown>;
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  screenshot(opts: { path: string }): Promise<unknown>;
}

interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<unknown>;
}

export interface PlaywrightLike {
  chromium: { launch(opts?: { headless?: boolean }): Promise<BrowserLike> };
}

export type PlaywrightLoader = () => Promise<PlaywrightLike | null>;

/** Default loader: dynamic-import playwright, or null if unavailable. */
export const defaultPlaywrightLoader: PlaywrightLoader = async () => {
  try {
    // Indirect specifier so TypeScript doesn't require `playwright` types at
    // build time (it's an OPTIONAL runtime dependency). Resolved from
    // node_modules when installed; throws (→ null) when it isn't.
    const pkg = 'playwright';
    const mod = (await import(pkg)) as unknown as PlaywrightLike;
    if (mod && mod.chromium && typeof mod.chromium.launch === 'function') return mod;
    return null;
  } catch {
    return null;
  }
};

/**
 * Navigate to a URL (optionally running a sequence of actions) and collect
 * verification signals. Best-effort — never throws; a missing browser or a
 * navigation failure is reported in the result.
 */
export async function runBrowserCheck(
  options: BrowserCheckOptions,
  loader: PlaywrightLoader = defaultPlaywrightLoader,
): Promise<BrowserCheckResult> {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const base: BrowserCheckResult = { ok: false, consoleErrors, pageErrors, failedRequests };

  const pw = await loader();
  if (!pw) {
    return {
      ...base,
      error:
        'browser automation unavailable — install Playwright (`npm i -D playwright && npx playwright install chromium`) to enable browser_check',
    };
  }

  const timeout = options.timeoutMs ?? 15_000;
  let browser: BrowserLike | undefined;
  try {
    browser = await pw.chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('requestfailed', (req) => {
      const f = req.failure();
      failedRequests.push(`${req.url()}${f ? ` (${f.errorText})` : ''}`);
    });

    await page.goto(options.url, { waitUntil: 'load', timeout });

    for (const action of options.actions ?? []) {
      switch (action.type) {
        case 'click':
          await page.click(action.selector, { timeout });
          break;
        case 'fill':
          await page.fill(action.selector, action.value, { timeout });
          break;
        case 'goto':
          await page.goto(action.url, { waitUntil: 'load', timeout });
          break;
        case 'wait':
          await page.waitForTimeout(action.ms);
          break;
        default:
          break;
      }
    }

    let selectorFound: boolean | undefined;
    if (options.waitForSelector) {
      try {
        await page.waitForSelector(options.waitForSelector, { timeout });
        selectorFound = true;
      } catch {
        selectorFound = false;
      }
    }

    let screenshotPath: string | undefined;
    if (options.screenshotPath) {
      try {
        await page.screenshot({ path: options.screenshotPath });
        screenshotPath = options.screenshotPath;
      } catch {
        // Screenshot is a nice-to-have; ignore failures.
      }
    }

    const title = await page.title().catch(() => undefined);
    return {
      ok: true,
      consoleErrors,
      pageErrors,
      failedRequests,
      url: page.url(),
      ...(title !== undefined ? { title } : {}),
      ...(selectorFound !== undefined ? { selectorFound } : {}),
      ...(screenshotPath ? { screenshotPath } : {}),
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
  }
}
