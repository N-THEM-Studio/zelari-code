import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  runBrowserCheck,
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

  it('reports a navigation failure without throwing', async () => {
    const res = await runBrowserCheck({ url: 'http://down' }, fakeLoader({ gotoThrows: true }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ERR_CONNECTION_REFUSED/);
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
