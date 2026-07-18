import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  runBrowserCheck,
  loadPlaywright,
  wrapEvaluateExpression,
  serializeEvaluateValue,
  type PlaywrightLoader,
  type BrowserAction,
} from '../../src/cli/browser/driver.js';
import { createBrowserTool } from '../../src/cli/browser/tools.js';
import { createBuiltinToolRegistry } from '../../src/cli/toolRegistry.js';

interface FakeOpts {
  consoleErrors?: string[];
  pageErrors?: string[];
  failedRequests?: Array<{ url: string; err: string }>;
  selectorPresent?: boolean;
  gotoThrows?: boolean;
  title?: string;
  finalUrl?: string;
  recordActions?: BrowserAction[];
  /** Body text for waitForText / textSample */
  bodyText?: string;
  /** Map expression → value for evaluate */
  evaluateMap?: Record<string, unknown>;
  evaluateThrow?: string;
}

function fakeLoader(opts: FakeOpts): PlaywrightLoader {
  return async () => ({
    chromium: {
      async launch() {
        const handlers: Record<string, ((arg: unknown) => void)[]> = {};
        const page = {
          on(event: string, cb: (arg: unknown) => void) {
            (handlers[event] ??= []).push(cb);
          },
          async goto() {
            if (opts.gotoThrows) throw new Error('net::ERR_CONNECTION_REFUSED');
            // Fire events as if they happened during load.
            for (const t of opts.consoleErrors ?? []) {
              handlers['console']?.forEach((cb) => cb({ type: () => 'error', text: () => t }));
            }
            for (const m of opts.pageErrors ?? []) {
              handlers['pageerror']?.forEach((cb) => cb(new Error(m)));
            }
            for (const r of opts.failedRequests ?? []) {
              handlers['requestfailed']?.forEach((cb) =>
                cb({ url: () => r.url, failure: () => ({ errorText: r.err }) }),
              );
            }
          },
          async click(selector: string) {
            opts.recordActions?.push({ type: 'click', selector });
          },
          async fill(selector: string, value: string) {
            opts.recordActions?.push({ type: 'fill', selector, value });
          },
          async waitForSelector() {
            if (!opts.selectorPresent) throw new Error('timeout');
          },
          async waitForTimeout() {},
          async waitForFunction(_fn: unknown, arg?: string) {
            const body = opts.bodyText ?? '';
            if (typeof arg === 'string' && body.includes(arg)) return;
            throw new Error('timeout waiting for text');
          },
          async evaluate(pageFunction: string | (() => unknown)) {
            if (opts.evaluateThrow) throw new Error(opts.evaluateThrow);
            if (typeof pageFunction === 'function') return pageFunction();
            const src = String(pageFunction);
            // textSample path
            if (src.includes('innerText') || src.includes('textContent')) {
              return opts.bodyText ?? '';
            }
            // Match evaluateMap keys against expression fragments
            for (const [k, v] of Object.entries(opts.evaluateMap ?? {})) {
              if (src.includes(k) || src.includes(`return (${k})`)) return v;
            }
            // unwrap `return (expr)` for simple literals
            const m = /^return\s*\((.*)\)\s*;?\s*$/s.exec(src.trim());
            if (m) {
              try {
                // eslint-disable-next-line no-new-func
                return Function(`"use strict"; return (${m[1]});`)();
              } catch {
                /* fallthrough */
              }
            }
            return undefined;
          },
          keyboard: {
            async press(key: string) {
              opts.recordActions?.push({ type: 'press', key });
            },
          },
          async title() {
            return opts.title ?? 'Fake';
          },
          url() {
            return opts.finalUrl ?? 'http://localhost:3000/';
          },
          async screenshot() {},
        };
        return {
          async newPage() {
            return page as never;
          },
          async close() {},
        };
      },
    },
  });
}

describe('runBrowserCheck', () => {
  it('collects console errors, page errors, and failed requests', async () => {
    const res = await runBrowserCheck(
      { url: 'http://localhost:3000' },
      fakeLoader({
        consoleErrors: ['Uncaught TypeError: x is undefined'],
        pageErrors: ['boom'],
        failedRequests: [{ url: 'http://localhost:3000/api', err: 'ERR_ABORTED' }],
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.consoleErrors).toContain('Uncaught TypeError: x is undefined');
    expect(res.pageErrors).toContain('boom');
    expect(res.failedRequests[0]).toMatch(/api \(ERR_ABORTED\)/);
    expect(res.title).toBe('Fake');
  });

  it('runs the action sequence in order', async () => {
    const recorded: BrowserAction[] = [];
    await runBrowserCheck(
      {
        url: 'http://x',
        actions: [
          { type: 'fill', selector: '#name', value: 'Ada' },
          { type: 'click', selector: '#submit' },
        ],
      },
      fakeLoader({ recordActions: recorded }),
    );
    expect(recorded).toEqual([
      { type: 'fill', selector: '#name', value: 'Ada' },
      { type: 'click', selector: '#submit' },
    ]);
  });

  it('reports selectorFound true/false from waitForSelector', async () => {
    const found = await runBrowserCheck({ url: 'x', waitForSelector: '#ok' }, fakeLoader({ selectorPresent: true }));
    expect(found.selectorFound).toBe(true);
    const missing = await runBrowserCheck({ url: 'x', waitForSelector: '#ok' }, fakeLoader({ selectorPresent: false }));
    expect(missing.selectorFound).toBe(false);
  });

  it('returns an install hint when Playwright is unavailable', async () => {
    const res = await runBrowserCheck({ url: 'x' }, async () => null);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Playwright/i);
  });

  it('loadPlaywright resolves a project-local install via cwd', async () => {
    // Minimal fake package that satisfies asPlaywright() — no real Playwright.
    const root = mkdtempSync(path.join(tmpdir(), 'pw-local-'));
    try {
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app' }));
      const pkgDir = path.join(root, 'node_modules', 'playwright');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: 'playwright', type: 'module', main: 'index.js' }),
      );
      writeFileSync(
        path.join(pkgDir, 'index.js'),
        'export const chromium = { launch: async () => ({ newPage: async () => ({}), close: async () => {} }) };\n',
      );
      const mod = await loadPlaywright(root);
      expect(mod).not.toBeNull();
      expect(typeof mod?.chromium.launch).toBe('function');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loadPlaywright returns null for a cwd with no playwright', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pw-none-'));
    try {
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app' }));
      // Bare import may still succeed if the host has playwright; only assert
      // the project-local path does not throw and returns a typed result.
      const mod = await loadPlaywright(root);
      // null or a global install — both are valid; must not throw.
      expect(mod === null || typeof mod?.chromium?.launch === 'function').toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a navigation failure without throwing', async () => {
    const res = await runBrowserCheck({ url: 'http://down' }, fakeLoader({ gotoThrows: true }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ERR_CONNECTION_REFUSED/);
  });

  it('runs evaluate and returns serialized values', async () => {
    const res = await runBrowserCheck(
      {
        url: 'http://x',
        actions: [
          { type: 'evaluate', expression: '1+2' },
          { type: 'evaluate', expression: 'document.title' },
        ],
      },
      fakeLoader({
        evaluateMap: { 'document.title': 'Game' },
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.evaluateResults).toHaveLength(2);
    expect(res.evaluateResults![0]!.value).toBe(3);
    expect(res.evaluateResults![1]!.value).toBe('Game');
  });

  it('captures evaluate errors without failing the whole check', async () => {
    const res = await runBrowserCheck(
      { url: 'http://x', actions: [{ type: 'evaluate', expression: 'boom()' }] },
      fakeLoader({ evaluateThrow: 'boom is not defined' }),
    );
    expect(res.ok).toBe(true);
    expect(res.evaluateResults![0]!.error).toMatch(/boom/);
  });

  it('waitForText sets textFound', async () => {
    const ok = await runBrowserCheck(
      {
        url: 'http://x',
        actions: [{ type: 'waitForText', text: 'Game Over' }],
      },
      fakeLoader({ bodyText: 'Hai raggiunto Wave 1\nGame Over' }),
    );
    expect(ok.textFound).toBe(true);

    const miss = await runBrowserCheck(
      {
        url: 'http://x',
        actions: [{ type: 'waitForText', text: 'Victory' }],
      },
      fakeLoader({ bodyText: 'Game Over' }),
    );
    expect(miss.textFound).toBe(false);
  });

  it('records press actions', async () => {
    const recorded: BrowserAction[] = [];
    await runBrowserCheck(
      { url: 'http://x', actions: [{ type: 'press', key: 'Space' }] },
      fakeLoader({ recordActions: recorded }),
    );
    expect(recorded).toEqual([{ type: 'press', key: 'Space' }]);
  });

  it('returns bodyTextSnippet when textSample is true', async () => {
    const res = await runBrowserCheck(
      { url: 'http://x', textSample: true },
      fakeLoader({ bodyText: 'HP 100  Wave 1' }),
    );
    expect(res.bodyTextSnippet).toContain('Wave 1');
  });
});

describe('evaluate helpers', () => {
  it('wrapEvaluateExpression adds return for expressions', () => {
    expect(wrapEvaluateExpression('1+2')).toBe('return (1+2)');
    expect(wrapEvaluateExpression('return 3')).toBe('return 3');
  });

  it('serializeEvaluateValue truncates large payloads', () => {
    const big = { x: 'y'.repeat(20_000) };
    const v = serializeEvaluateValue(big) as { truncated?: boolean };
    expect(v.truncated).toBe(true);
  });
});

describe('browser_check tool', () => {
  const ctx = { signal: new AbortController().signal, cwd: '/x', audit: () => {}, sessionId: 't' };

  it('reports clean=true when there are no error signals', async () => {
    const tool = createBrowserTool({ loader: fakeLoader({ title: 'App' }), screenshotDir: tmpdir() });
    const res = await tool.execute({ url: 'http://localhost:3000', screenshot: false }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.value as { clean: boolean }).clean).toBe(true);
  });

  it('flags weak smoke when no DOM/evaluate assertions', async () => {
    const tool = createBrowserTool({ loader: fakeLoader({ title: 'App' }), screenshotDir: tmpdir() });
    const res = await tool.execute(
      { url: 'http://localhost:3000', screenshot: false, actions: [{ type: 'wait', ms: 100 }] },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const v = res.value as { smokeStrength?: string; note?: string };
      expect(v.smokeStrength).toBe('weak');
      expect(v.note).toMatch(/Weak smoke/i);
    }
  });

  it('smokeStrength asserted when waitForSelector used', async () => {
    const tool = createBrowserTool({
      loader: fakeLoader({ selectorPresent: true }),
      screenshotDir: tmpdir(),
    });
    const res = await tool.execute(
      { url: 'http://x', screenshot: false, waitForSelector: '#game-over' },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.value as { smokeStrength?: string }).smokeStrength).toBe('asserted');
    }
  });

  it('reports clean=false when there are console errors', async () => {
    const tool = createBrowserTool({ loader: fakeLoader({ consoleErrors: ['bad'] }), screenshotDir: tmpdir() });
    const res = await tool.execute({ url: 'http://localhost:3000', screenshot: false }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const v = res.value as { clean: boolean; consoleErrors: string[] };
      expect(v.clean).toBe(false);
      expect(v.consoleErrors).toContain('bad');
    }
  });

  it('notes when browser automation is unavailable', async () => {
    const tool = createBrowserTool({ loader: async () => null });
    const res = await tool.execute({ url: 'x' }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.value as { ok: boolean; note?: string }).note).toMatch(/Playwright/i);
  });
});

describe('browser_check in the registry', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'br-reg-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('is registered in the full registry', () => {
    const { tools } = createBuiltinToolRegistry({ root, lspProvider: null });
    expect(tools.map((t) => t.name)).toContain('browser_check');
  });

  it('is omitted from a read-only sub-agent registry', () => {
    const { registry } = createBuiltinToolRegistry({ root, readOnly: true });
    expect(registry.get('browser_check')).toBeUndefined();
  });
});
