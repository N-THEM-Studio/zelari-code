/**
 * browser/tools — the `browser_check` visual-verification tool.
 *
 * Lets the agent confirm a web change actually works in a real browser:
 * navigate the running app, optionally click/fill, and get back console
 * errors, uncaught exceptions, failed requests, the title/URL, whether an
 * expected element appeared, and a screenshot path. Optional Playwright dep —
 * degrades with install instructions when it's not present.
 */

import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { typedOk, type ToolDefinition } from '@zelari/core/harness/tools/toolTypes';
import { runBrowserCheck, type PlaywrightLoader, type BrowserAction } from './driver.js';

const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), selector: z.string().min(1) }),
  z.object({ type: z.literal('fill'), selector: z.string().min(1), value: z.string() }),
  z.object({ type: z.literal('wait'), ms: z.number().int().positive().max(30_000) }),
  z.object({ type: z.literal('goto'), url: z.string().min(1) }),
]);

export interface BrowserToolDeps {
  /** Inject the Playwright loader (tests). Defaults to a dynamic import. */
  loader?: PlaywrightLoader;
  /** Where screenshots are written (defaults to the OS temp dir). */
  screenshotDir?: string;
}

export function createBrowserTool(deps: BrowserToolDeps = {}): ToolDefinition {
  return {
    name: 'browser_check',
    description:
      'Open a URL in a headless browser to VERIFY a web change: optionally run ' +
      'click/fill/goto/wait actions, then report console errors, uncaught page ' +
      'exceptions, failed network requests, the final title/URL, whether an ' +
      'expected selector appeared, and a screenshot path. Use it to confirm UI ' +
      'edits actually render and run — stronger than "tests pass" for front-end. ' +
      'Requires Playwright (optional dependency).',
    permissions: ['network'],
    // A browser launch + navigation can take a while.
    timeoutMs: 60_000,
    inputSchema: z.object({
      url: z.string().min(1).describe('URL to open (e.g. http://localhost:3000).'),
      actions: z.array(ActionSchema).optional().describe('Optional sequence of interactions before checking.'),
      waitForSelector: z.string().optional().describe('Assert this CSS selector is present after actions.'),
      screenshot: z.boolean().optional().describe('Save a screenshot (default true).'),
    }),
    execute: async (args, ctx) => {
      const a = args as {
        url: string;
        actions?: BrowserAction[];
        waitForSelector?: string;
        screenshot?: boolean;
      };
      const dir = deps.screenshotDir ?? os.tmpdir();
      const screenshotPath =
        a.screenshot === false ? undefined : path.join(dir, `zelari-browser-${Date.now()}.png`);
      // Pass ctx.cwd so a project-local `npm i -D playwright` is found (the
      // CLI process itself cannot see it via bare import when installed -g).
      const result = await runBrowserCheck(
        {
          url: a.url,
          cwd: ctx.cwd,
          ...(a.actions ? { actions: a.actions } : {}),
          ...(a.waitForSelector ? { waitForSelector: a.waitForSelector } : {}),
          ...(screenshotPath ? { screenshotPath } : {}),
        },
        deps.loader,
      );
      if (!result.ok) {
        return typedOk({ ok: false, note: result.error ?? 'browser check failed' });
      }
      // A clean load with no error signals is the "pass" the agent looks for.
      const clean =
        result.consoleErrors.length === 0 &&
        result.pageErrors.length === 0 &&
        result.failedRequests.length === 0 &&
        result.selectorFound !== false;
      return typedOk({
        ok: true,
        clean,
        title: result.title,
        url: result.url,
        consoleErrors: result.consoleErrors,
        pageErrors: result.pageErrors,
        failedRequests: result.failedRequests,
        ...(result.selectorFound !== undefined ? { selectorFound: result.selectorFound } : {}),
        ...(result.screenshotPath ? { screenshotPath: result.screenshotPath } : {}),
      });
    },
  };
}
