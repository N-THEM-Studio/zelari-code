/**
 * automations/browser/pageAdapter.ts — the Playwright page/context adapter (F3.1/F3.2).
 *
 * The minimal structural seams the automation orchestration talks to, plus the
 * thin adapters that narrow a real Playwright page/context onto them. Keeping
 * this separate from session.ts holds each module under the size budget and
 * keeps the "what the orchestration sees" contract in one place.
 *
 * Playwright itself is never imported here — only structural (duck-typed)
 * interfaces — so the orchestration stays unit-testable with fake pages.
 */

/** How long a fallback selector may take to appear before we call it absent. */
export const SELECTOR_TIMEOUT_MS = 5_000;

// --- Minimal structural surface of the Playwright API we use (no pw types). ---
interface PwKeyboardLike {
  press(key: string): Promise<unknown>;
}
interface PwPageLike {
  goto(url: string, opts?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
  url(): string;
  $(selector: string): Promise<unknown | null>;
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  close(): Promise<unknown>;
  // Composer surface (F3.2 publisher). Present on a real Playwright page.
  click(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  type(selector: string, text: string, opts?: { delay?: number }): Promise<unknown>;
  keyboard: PwKeyboardLike;
  setInputFiles(selector: string, files: string[]): Promise<unknown>;
  screenshot(opts?: { path?: string }): Promise<unknown>;
  bringToFront?(): Promise<void>;
  $$eval<T, A = unknown>(selector: string, fn: (els: unknown[], arg: A) => T, arg?: A): Promise<T>;
  $eval<T>(selector: string, fn: (el: unknown) => T): Promise<T>;
}
interface PwContextLike {
  newPage(): Promise<PwPageLike>;
  pages(): PwPageLike[];
  close(): Promise<unknown>;
  on(event: 'close', cb: () => void): void;
  /** Playwright BrowserContext.cookies() — present on real contexts. */
  cookies?(): Promise<Array<{ name: string; domain?: string }>>;
}
/** Shape of the lazily-loaded Playwright module (chromium only). */
export interface PwModuleLike {
  chromium: {
    launchPersistentContext(
      dir: string,
      o?: { headless?: boolean; args?: string[] },
    ): Promise<PwContextLike>;
  };
}

/** Page surface the orchestration uses (adapter over a real Playwright page). */
export interface BrowserPageLike {
  goto(url: string, opts?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
  url?(): string;
  /** True when `selector` is present (waits up to `timeoutMs` for late renders). */
  hasSelector(selector: string, timeoutMs?: number): Promise<boolean>;
  close(): Promise<unknown>;
  /** Best-effort window foreground (headed login flows). Optional on fakes. */
  bringToFront?(): Promise<void>;
  // --- Optional composer surface (F3.2). The real adapter always provides it;
  // keeping them optional means the minimal F3.1 fakes stay assignable. ---
  waitForSelector?(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  click?(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  /** Type text into `selector` (per-char cadence is the caller's concern). */
  typeText?(selector: string, text: string, opts?: { delayMs?: number }): Promise<unknown>;
  press?(key: string): Promise<unknown>;
  setInputFiles?(selector: string, files: string[]): Promise<unknown>;
  screenshot?(path: string): Promise<unknown>;
  /** Absolute hrefs of every element matching `selector` (order preserved). */
  hrefs?(selector: string): Promise<string[]>;
  /** {href,text} per element matching `selector` (text = enclosing <article>). */
  linkTexts?(selector: string): Promise<Array<{ href: string; text: string }>>;
  /** Per-article first permalink-shaped anchor + article text (own-profile scan). */
  articlePermalinks?(): Promise<Array<{ href: string; text: string }>>;
  /**
   * Dump {tag,role,aria,testid,text,disabled} for elements matching
   * `selector` (calibration). JSON-safe; text capped by the eval itself.
   */
  controls?(selector: string): Promise<
    Array<{ tag: string; role?: string; aria?: string; testid?: string; text: string; disabled?: boolean }>
  >;
  /**
   * Click the first element under `scopeSelector` whose normalized aria-label
   * OR text content EXACTLY equals one of `texts` (in-page click — immune to
   * overlay interception and to substring traps like the feed's "Azioni per
   * questo post"). Returns the matched label, or null when nothing matched.
   */
  clickText?(scopeSelector: string, texts: readonly string[]): Promise<string | null>;
}
/** Persistent context surface the orchestration uses. */
export interface PersistentContextLike {
  newPage(): Promise<BrowserPageLike>;
  pages(): BrowserPageLike[];
  close(): Promise<unknown>;
  /** Subscribe to context close (the user closed the window). */
  onClose(cb: () => void): void;
  /**
   * Profile cookies — the locale-proof login signal (X `auth_token`, FB
   * `c_user`+`xs`). Optional so minimal fakes stay assignable.
   */
  cookies?(): Promise<Array<{ name: string; domain?: string }>>;
}
/** Injectable seam: open a persistent context (null when Playwright is absent). */
export type ContextOpener = (opts: {
  channel: string;
  headless: boolean;
  cwd?: string;
}) => Promise<PersistentContextLike | null>;

/** Adapt a real Playwright page onto the orchestration's BrowserPageLike seam. */
export function adaptPage(p: PwPageLike): BrowserPageLike {
  return {
    goto: (url, opts) => p.goto(url, opts),
    url: () => p.url(),
    close: () => p.close(),
    bringToFront: async () => {
      await p.bringToFront?.();
    },
    hasSelector: async (selector, timeoutMs = SELECTOR_TIMEOUT_MS) => {
      try {
        if ((await p.$(selector)) !== null) return true;
        await p.waitForSelector(selector, { timeout: timeoutMs });
        return true;
      } catch {
        return false;
      }
    },
    waitForSelector: (selector, opts) => p.waitForSelector(selector, opts),
    click: (selector, opts) => p.click(selector, opts),
    typeText: (selector, text, opts) => p.type(selector, text, { delay: opts?.delayMs }),
    press: (key) => p.keyboard.press(key),
    setInputFiles: (selector, files) => p.setInputFiles(selector, files),
    screenshot: (path) => p.screenshot({ path }),
    hrefs: async (selector) =>
      p.$$eval(selector, (els) => els.map((e) => String((e as { href?: string }).href ?? ''))),
    linkTexts: async (selector) =>
      p.$$eval(selector, (els) =>
        els.map((e) => {
          const a = e as {
            href?: string;
            textContent?: string | null;
            closest?: (s: string) => { textContent?: string | null } | null;
          };
          const article = typeof a.closest === 'function' ? a.closest('article') : null;
          const text = (article?.textContent ?? a.textContent ?? '').trim();
          return { href: String(a.href ?? ''), text };
        }),
      ),
    articlePermalinks: async () =>
      p.$$eval("div[role='article']", (els) => {
        const shapes = /(\/posts\/|permalink\.php|story\.php|\/share\/p\/)/;
        const out: Array<{ href: string; text: string }> = [];
        for (const e of els) {
          const el = e as Element;
          const anchor = Array.from(el.querySelectorAll('a[href]'))
            .map((a) => String((a as { href?: string }).href ?? ''))
            .find((h) => shapes.test(h));
          const text = (el.textContent ?? '').replace(/\s+/g, ' ').slice(0, 600);
          if (anchor !== undefined && anchor.length > 0) out.push({ href: anchor, text });
        }
        return out;
      }),
    controls: (selector) =>
      p.$$eval(selector, (els) =>
        els
          .map((e) => {
            const el = e as {
              tagName?: string;
              getAttribute?: (n: string) => string | null;
              textContent?: string | null;
              hasAttribute?: (n: string) => boolean;
            };
            const attr = (n: string): string | undefined =>
              typeof el.getAttribute === 'function' ? (el.getAttribute(n) ?? undefined) : undefined;
            return {
              tag: String(el.tagName ?? '').toLowerCase(),
              role: attr('role'),
              aria: attr('aria-label'),
              testid: attr('data-testid'),
              text: String(el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100),
              disabled: typeof el.hasAttribute === 'function' && el.hasAttribute('disabled') ? true : undefined,
            };
          })
          .slice(0, 100),
      ),
    clickText: (scopeSelector, texts) =>
      p.$$eval<string | null, readonly string[]>(
        scopeSelector,
        (els, labels) => {
          const norm = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
          const wanted = labels.map((l) => norm(l));
          const vis = (node: Element): boolean => {
            const r = node.getBoundingClientRect();
            const st = getComputedStyle(node);
            return (
              r.width > 2 &&
              r.height > 2 &&
              st.visibility !== 'hidden' &&
              st.display !== 'none' &&
              Number(st.opacity) > 0.1
            );
          };
          let hit: {
            click: () => void;
            aria: string | null;
            text: string;
          } | null = null;
          for (const e of els) {
            const el = e as Element & {
              innerText?: string;
              textContent?: string | null;
              getAttribute?: (n: string) => string | null;
              hasAttribute?: (n: string) => boolean;
              click?: () => void;
            };
            const aria = typeof el.getAttribute === 'function' ? el.getAttribute('aria-label') : null;
            const inner = String(el.innerText ?? el.textContent ?? '');
            const ariaN = norm(aria);
            const textN = norm(inner);
            if (!wanted.some((w) => w === ariaN || w === textN)) continue;
            if (typeof el.hasAttribute === 'function' && (el.hasAttribute('disabled') || el.getAttribute?.('aria-disabled') === 'true')) continue;
            if (!vis(el)) continue;
            if (typeof el.click !== 'function') continue;
            hit = { click: el.click.bind(el), aria, text: inner };
          }
          if (!hit) return null;
          hit.click();
          return norm(hit.aria ?? hit.text);
        },
        texts,
      ),
  };
}

/** Adapt a real Playwright persistent context onto PersistentContextLike. */
export function adaptContext(ctx: PwContextLike): PersistentContextLike {
  return {
    newPage: async () => adaptPage(await ctx.newPage()),
    pages: () => ctx.pages().map(adaptPage),
    close: () => ctx.close(),
    cookies:
      typeof ctx.cookies === 'function'
        ? async () => (await ctx.cookies?.()) ?? []
        : undefined,
    onClose: (cb) => {
      try {
        ctx.on('close', cb);
      } catch {
        // 'close' unsupported on a partial fake — the timeout still bounds us.
      }
    },
  };
}
