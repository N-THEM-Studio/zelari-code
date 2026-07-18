/**
 * browser/driver — drive a headless browser to verify web changes.
 *
 * The "visual verification loop" for web projects: after the agent edits a UI,
 * it navigates the running app and gets back the signals an LLM can actually
 * act on — console errors, uncaught page exceptions, failed network requests,
 * the final title/URL, whether an expected selector is present, evaluate
 * results, and a saved screenshot path. Far stronger than "the tests pass"
 * for front-end work.
 *
 * Playwright is an OPTIONAL dependency, loaded via dynamic import so it is not
 * a hard requirement of the package. When it (or a browser) isn't available,
 * the tool degrades with a clear message. The loader is injectable, so the
 * driver's orchestration is unit-testable with a fake browser.
 *
 * Resolution order (v1.7.2+): project `cwd` node_modules first (where
 * `npm i -D playwright` lands), then the bare package import (global / CLI
 * tree). Matches how the plugin gate detects presence.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Max length of an evaluate expression (chars). */
const MAX_EVAL_EXPR = 4_000;
/** Max JSON-serialized evaluate result size. */
const MAX_EVAL_RESULT = 8_000;
/** Max body text sample returned to the agent. */
const MAX_BODY_SNIPPET = 2_000;

export type BrowserAction =
  | { type: 'click'; selector: string }
  | { type: 'fill'; selector: string; value: string }
  | { type: 'wait'; ms: number }
  | { type: 'goto'; url: string }
  /** Run JS in the page context (Playwright page.evaluate). Return must be JSON-serializable. */
  | { type: 'evaluate'; expression: string }
  /** Keyboard key press (e.g. "Space", "KeyW", "ArrowLeft"). */
  | { type: 'press'; key: string }
  /** Wait until the document body contains this substring (case-sensitive). */
  | { type: 'waitForText'; text: string; timeoutMs?: number };

export interface EvaluateResultEntry {
  expression: string;
  /** JSON-serializable value, or null when error. */
  value?: unknown;
  error?: string;
}

export interface BrowserCheckOptions {
  url: string;
  actions?: BrowserAction[];
  /** Assert this selector is present after actions run. */
  waitForSelector?: string;
  /** Where to save the screenshot (PNG). */
  screenshotPath?: string;
  /** Overall navigation timeout (ms, default 15000). */
  timeoutMs?: number;
  /**
   * Working directory used to resolve a project-local Playwright install
   * (`npm i -D playwright`). Defaults to `process.cwd()` when omitted.
   */
  cwd?: string;
  /** Include a short visible body-text sample in the result. */
  textSample?: boolean;
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
  /** Results from `evaluate` actions (in order). */
  evaluateResults?: EvaluateResultEntry[];
  /** True when a waitForText action succeeded; false if any timed out. */
  textFound?: boolean;
  /** Optional body.innerText snippet when textSample was requested. */
  bodyTextSnippet?: string;
}

// --- Minimal structural surface of the Playwright API we use ---------------
// Kept intentionally loose (no dependency on playwright's types).

interface KeyboardLike {
  press(key: string, opts?: { timeout?: number }): Promise<unknown>;
}

interface PageLike {
  on(event: 'console', cb: (msg: { type(): string; text(): string }) => void): void;
  on(event: 'pageerror', cb: (err: Error) => void): void;
  on(event: 'requestfailed', cb: (req: { url(): string; failure(): { errorText: string } | null }) => void): void;
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  click(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  fill(selector: string, value: string, opts?: { timeout?: number }): Promise<unknown>;
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<unknown>;
  waitForFunction(
    fn: string | ((arg: string) => boolean),
    arg?: string,
    opts?: { timeout?: number },
  ): Promise<unknown>;
  evaluate<T = unknown>(pageFunction: string | (() => T)): Promise<T>;
  title(): Promise<string>;
  url(): string;
  screenshot(opts: { path: string }): Promise<unknown>;
  keyboard?: KeyboardLike;
}

interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<unknown>;
}

export interface PlaywrightLike {
  chromium: { launch(opts?: { headless?: boolean }): Promise<BrowserLike> };
}

export type PlaywrightLoader = () => Promise<PlaywrightLike | null>;

/** Coerce a dynamic-import module shape into PlaywrightLike (or null). */
function asPlaywright(mod: unknown): PlaywrightLike | null {
  if (!mod || typeof mod !== 'object') return null;
  const m = mod as PlaywrightLike & { default?: PlaywrightLike };
  if (m.chromium && typeof m.chromium.launch === 'function') return m;
  const d = m.default;
  if (d && d.chromium && typeof d.chromium.launch === 'function') return d;
  return null;
}

/**
 * Load Playwright from the project tree (cwd) first, then fall back to a bare
 * package import (global install / hoisted into the CLI's node_modules).
 *
 * Why cwd-first: the plugin gate installs with `npm i -D playwright`, which
 * lands in `<project>/node_modules`. A bare `import('playwright')` from the
 * globally-installed CLI resolves against the CLI package, not the project —
 * so after a successful project install the old loader still returned null and
 * the boot gate re-prompted forever.
 */
export async function loadPlaywright(cwd?: string): Promise<PlaywrightLike | null> {
  const base = cwd && cwd.length > 0 ? path.resolve(cwd) : undefined;
  if (base) {
    try {
      // createRequire base file need not exist; resolution walks node_modules
      // from its directory upward (same algorithm as a require from that dir).
      const req = createRequire(path.join(base, 'package.json'));
      const resolved = req.resolve('playwright');
      const mod = await import(pathToFileURL(resolved).href);
      const pw = asPlaywright(mod);
      if (pw) return pw;
    } catch {
      // Not installed under this project tree — fall through.
    }
  }

  try {
    // Indirect specifier so TypeScript doesn't require `playwright` types at
    // build time (it's an OPTIONAL runtime dependency).
    const pkg = 'playwright';
    const mod = (await import(pkg)) as unknown;
    return asPlaywright(mod);
  } catch {
    return null;
  }
}

/**
 * Default loader: resolve Playwright from `process.cwd()` then bare import.
 * Prefer `loadPlaywright(explicitCwd)` at call sites that know the workspace.
 */
export const defaultPlaywrightLoader: PlaywrightLoader = async () =>
  loadPlaywright(process.cwd());

/** Cap and JSON-safe-clone evaluate return values for the agent. */
export function serializeEvaluateValue(value: unknown): unknown {
  try {
    const json = JSON.stringify(value, (_k, v) => {
      if (typeof v === 'function') return '[Function]';
      if (typeof v === 'bigint') return v.toString();
      if (v instanceof Error) return { name: v.name, message: v.message };
      return v;
    });
    if (json === undefined) return null;
    if (json.length > MAX_EVAL_RESULT) {
      return {
        truncated: true,
        preview: json.slice(0, MAX_EVAL_RESULT),
      };
    }
    return JSON.parse(json) as unknown;
  } catch (err) {
    return {
      error: `non-serializable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Wrap a user expression as a Playwright evaluate **function body**.
 * Playwright treats string pageFunctions as `function(){ <body> }`, so we
 * must `return` the value.
 */
export function wrapEvaluateExpression(expression: string): string {
  const expr = expression.trim();
  if (!expr) return 'return undefined';
  // Multi-statement or already has return → use as body (ensure return if missing).
  if (/\breturn\b/.test(expr) || expr.includes('\n')) {
    return expr;
  }
  // Single expression
  return `return (${expr})`;
}

/**
 * Navigate to a URL (optionally running a sequence of actions) and collect
 * verification signals. Best-effort — never throws; a missing browser or a
 * navigation failure is reported in the result.
 */
export async function runBrowserCheck(
  options: BrowserCheckOptions,
  loader?: PlaywrightLoader,
): Promise<BrowserCheckResult> {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const evaluateResults: EvaluateResultEntry[] = [];
  const base: BrowserCheckResult = { ok: false, consoleErrors, pageErrors, failedRequests };

  const resolve =
    loader ??
    (() => loadPlaywright(options.cwd ?? process.cwd()));
  const pw = await resolve();
  if (!pw) {
    return {
      ...base,
      error:
        'browser automation unavailable — Playwright is not installed in this workspace. ' +
        'Install it with: `zelari-code --plugins-install playwright --cwd .` ' +
        '(or Desktop banner “Install”, or CLI `/plugins install playwright`, or ' +
        '`npm i -D playwright && npx playwright install chromium`). ' +
        'Then re-run browser_check.',
    };
  }

  const timeout = options.timeoutMs ?? 15_000;
  let browser: BrowserLike | undefined;
  let textFound: boolean | undefined;
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
        case 'press': {
          const key = action.key.trim();
          if (!key) break;
          if (page.keyboard && typeof page.keyboard.press === 'function') {
            await page.keyboard.press(key, { timeout });
          } else {
            // Fallback for fakes / surfaces without keyboard
            await page.evaluate(
              wrapEvaluateExpression(
                `document.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true})); true`,
              ),
            );
          }
          break;
        }
        case 'waitForText': {
          const needle = action.text;
          const t = action.timeoutMs ?? timeout;
          try {
            // String function body: Playwright injects as function(arg) { ... }
            await page.waitForFunction(
              `return (document.body && (document.body.innerText || document.body.textContent || '')).includes(arguments[0])`,
              needle,
              { timeout: t },
            );
            textFound = textFound === false ? false : true;
          } catch {
            textFound = false;
          }
          break;
        }
        case 'evaluate': {
          const raw = action.expression ?? '';
          if (raw.length > MAX_EVAL_EXPR) {
            evaluateResults.push({
              expression: raw.slice(0, 120) + '…',
              error: `expression too long (max ${MAX_EVAL_EXPR} chars)`,
            });
            break;
          }
          if (!raw.trim()) {
            evaluateResults.push({ expression: raw, error: 'empty expression' });
            break;
          }
          try {
            const wrapped = wrapEvaluateExpression(raw);
            const value = await page.evaluate(wrapped);
            evaluateResults.push({
              expression: raw.length > 200 ? raw.slice(0, 200) + '…' : raw,
              value: serializeEvaluateValue(value),
            });
          } catch (err) {
            evaluateResults.push({
              expression: raw.length > 200 ? raw.slice(0, 200) + '…' : raw,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          break;
        }
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

    let bodyTextSnippet: string | undefined;
    if (options.textSample) {
      try {
        const text = await page.evaluate(
          wrapEvaluateExpression(
            `(document.body?.innerText || document.body?.textContent || '').trim()`,
          ),
        );
        if (typeof text === 'string' && text.length > 0) {
          bodyTextSnippet =
            text.length > MAX_BODY_SNIPPET
              ? text.slice(0, MAX_BODY_SNIPPET) + '…'
              : text;
        }
      } catch {
        // ignore
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
      ...(evaluateResults.length > 0 ? { evaluateResults } : {}),
      ...(textFound !== undefined ? { textFound } : {}),
      ...(bodyTextSnippet !== undefined ? { bodyTextSnippet } : {}),
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
