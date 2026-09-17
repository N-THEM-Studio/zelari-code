/**
 * automations/browser/fbPublisher.ts — the Facebook (Page) browser publisher (F3.3).
 *
 * Mirrors ./publisher.ts (X): implements the ChannelAdapter seam by DRIVING the
 * real facebook.com composer on the persistent profile from ./session.ts. This
 * module owns the LIFECYCLE and the hard safety invariant; the step mechanics
 * live in ./fbComposer.ts.
 *
 *   1) HARD health gate — `checkLogin('facebook')` FIRST. `loggedIn !== true` ⇒ a
 *      typed ReloginRequiredError, WITHOUT opening any page or typing anything
 *      (P1: no blind posting). The runner maps that to `relogin_required`/exit 4.
 *   2) open persistent context → run the composer flow (open, type, media, Post,
 *      extract permalink, screenshot) → close.
 *
 * Playwright stays lazy via ./session.ts. The composer surface is re-exported so
 * importers get one entry point.
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
  toComposerPage,
} from './humanInput.js';
import { ReloginRequiredError } from './errors.js';
import { runFacebookComposerPublish } from './fbComposer.js';
import type { ChannelAdapter, ChannelPublishInput, ChannelPublishResult } from '../channels/types.js';

/** Re-export the Facebook composer surface (errors, constants, helpers, types). */
export { ReloginRequiredError } from './errors.js';
export * from './fbComposer.js';

/** Injectable seams (tests supply fakes; prod uses the real session helpers). */
export interface FacebookPublisherDeps {
  runId?: string;
  automationId?: string;
  /** Project cwd: Playwright resolution + evidence root. Default process.cwd(). */
  cwd?: string;
  /** Force headedness. Default HEADED (FB/X skip submit in headless). */
  headless?: boolean;
  opener?: ContextOpener;
  checkLoginFn?: (channel: string, opts?: { cwd?: string }) => Promise<HealthReport>;
  delayMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Optional Page/landing URL to open the composer from (else the home feed). */
  pageUrl?: string;
}

/** Build the Facebook (browser) adapter implementing the ChannelAdapter seam. */
export function createFacebookBrowserPublisher(deps: FacebookPublisherDeps = {}): ChannelAdapter {
  const channel = 'facebook';
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
        const result = await runFacebookComposerPublish(page, sel, input, {
          cwd,
          automationId,
          runId,
          delayMs,
          sleep,
          pageUrl: deps.pageUrl,
        });
        (deps.log ?? (() => undefined))(`[facebook-browser] posted ${result.url}`);
        return result;
      } finally {
        await ctx.close().catch(() => undefined);
      }
    },
  };
}
