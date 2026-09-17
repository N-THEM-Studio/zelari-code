/**
 * automations/browser/publisher.ts — the X (twitter) browser publisher (F3.2).
 *
 * Implements the ChannelAdapter seam by DRIVING the real x.com composer on the
 * persistent profile from ./session.ts. This module owns the LIFECYCLE and the
 * hard safety invariant; the step mechanics live in ./composer.ts.
 *
 *   1) HARD health gate — `checkLogin('x')` FIRST. `loggedIn !== true` ⇒ a typed
 *      ReloginRequiredError, WITHOUT opening any page or typing anything (P1:
 *      no blind posting). The runner maps that to status `relogin_required`.
 *   2) open persistent context → run the composer flow (open, type, media, Post,
 *      extract permalink, screenshot) → close.
 *
 * The composer surface (and its typed errors/constants) is re-exported here so
 * existing importers keep one entry point. Playwright stays lazy via ./session.ts.
 */
import {
  checkLogin,
  defaultContextOpener,
  PLAYWRIGHT_UNAVAILABLE_HINT,
  type ContextOpener,
  type HealthReport,
} from './session.js';
import { loadSelectors } from './selectors.js';
import {
  defaultCharDelayMs,
  defaultSleep,
  resolveHeadless,
  ReloginRequiredError,
  runComposerPublish,
  toComposerPage,
} from './composer.js';
import type { ChannelAdapter, ChannelPublishInput, ChannelPublishResult } from '../channels/types.js';

/** Re-export the composer surface (errors, constants, helpers, types). */
export * from './composer.js';

/** Injectable seams (tests supply fakes; prod uses the real session helpers). */
export interface XPublisherDeps {
  runId?: string;
  automationId?: string;
  /** Project cwd: Playwright resolution + evidence root. Default process.cwd(). */
  cwd?: string;
  /** Force headedness (debug). Default: headless unless ZELARI_BROWSER_HEADED=1. */
  headless?: boolean;
  opener?: ContextOpener;
  checkLoginFn?: (channel: string, opts?: { cwd?: string }) => Promise<HealthReport>;
  delayMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/** Build the X (browser) adapter implementing the ChannelAdapter seam. */
export function createXBrowserPublisher(deps: XPublisherDeps = {}): ChannelAdapter {
  const channel = 'x';
  const runId = deps.runId ?? 'unknown';
  const automationId = deps.automationId ?? 'unknown';
  const cwd = deps.cwd ?? process.cwd();
  const opener = deps.opener ?? defaultContextOpener;
  const check = deps.checkLoginFn ?? checkLogin;
  const delayMs = deps.delayMs ?? defaultCharDelayMs;
  const sleep = deps.sleep ?? defaultSleep;

  return {
    id: channel,
    async publish(input: ChannelPublishInput): Promise<ChannelPublishResult> {
      // 1) HARD health gate — BEFORE opening any page or typing anything (P1).
      const health = await check(channel, { cwd });
      if (!health.loggedIn) throw new ReloginRequiredError(channel);

      const sel = await loadSelectors(channel);
      const ctx = await opener({ channel, headless: resolveHeadless(deps), cwd });
      if (!ctx) throw new Error(PLAYWRIGHT_UNAVAILABLE_HINT);
      try {
        const page = toComposerPage(ctx.pages()[0] ?? (await ctx.newPage()));
        const result = await runComposerPublish(page, sel, input, {
          cwd,
          automationId,
          runId,
          delayMs,
          sleep,
        });
        (deps.log ?? (() => undefined))(`[x-browser] posted ${result.url}`);
        return result;
      } finally {
        await ctx.close().catch(() => undefined);
      }
    },
  };
}
