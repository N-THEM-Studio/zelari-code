/**
 * automations/channels/registry.ts — channel id + mode → adapter (ADR-0037 §F2/F3.2/F3.3).
 *
 * `resolveAdapter` is mode-aware:
 *   - 'dry-run' (default) → the F2 dry-run adapter, unchanged, network-free.
 *   - 'browser'           → the REAL publisher for the channel:
 *       * 'x'        → the F3.2 X browser publisher;
 *       * 'facebook' → the F3.3 Facebook (Page) browser publisher;
 *       * 'website'  → the F3.3 webhook adapter (HMAC-SHA256, NO browser — the
 *                      'browser' mode just means "real delivery, not dry-run").
 * An unknown channel id THROWS in both modes so the runner records `failed`+exit 1.
 *
 * `resolveChannelAdapter` is kept as the F2 back-compat entry (dry-run only).
 */
import { createFacebookBrowserPublisher, type FacebookPublisherDeps } from '../browser/fbPublisher.js';
import { createXBrowserPublisher, type XPublisherDeps } from '../browser/publisher.js';
import { createDryRunAdapter } from './dryRun.js';
import type { ChannelAdapter } from './types.js';
import { createWebsiteChannelAdapter, type WebsiteAdapterDeps } from './website.js';

/** Channel ids supported by the DRY-RUN adapter (F2). */
export const DRY_RUN_CHANNELS = ['x', 'facebook', 'website'] as const;

const DRY_RUN_SET: ReadonlySet<string> = new Set(DRY_RUN_CHANNELS);

/** Delivery mode. Absent ⇒ 'dry-run' (safe default; no silent real posting). */
export type PublishMode = 'dry-run' | 'browser';

export interface ResolveAdapterOpts {
  publishMode?: PublishMode;
  runId: string;
  automationId?: string;
  /** Project cwd (Playwright resolution + evidence root). */
  cwd?: string;
  /** Browser seams forwarded to the X publisher (tests inject fakes). */
  browser?: Omit<XPublisherDeps, 'runId' | 'automationId' | 'cwd'>;
  /** Browser seams forwarded to the Facebook publisher (tests inject fakes). */
  facebook?: Omit<FacebookPublisherDeps, 'runId' | 'automationId' | 'cwd'>;
  /** Seams forwarded to the website webhook adapter (tests inject a fake fetch). */
  website?: WebsiteAdapterDeps;
}

/** Mode-aware adapter factory. Unknown channel ⇒ throw (never a phantom success). */
export function resolveAdapter(channelId: string, opts: ResolveAdapterOpts): ChannelAdapter {
  const mode = opts.publishMode ?? 'dry-run';
  if (mode === 'browser') {
    if (channelId === 'x') {
      return createXBrowserPublisher({
        ...opts.browser,
        runId: opts.runId,
        automationId: opts.automationId,
        cwd: opts.cwd,
      });
    }
    if (channelId === 'facebook') {
      return createFacebookBrowserPublisher({
        ...opts.facebook,
        runId: opts.runId,
        automationId: opts.automationId,
        cwd: opts.cwd,
      });
    }
    if (channelId === 'website') {
      return createWebsiteChannelAdapter({
        ...opts.website,
        runId: opts.runId,
        automationId: opts.automationId,
      });
    }
    throw new Error(`unknown channel: ${channelId} (F2 supports: ${DRY_RUN_CHANNELS.join(', ')})`);
  }
  if (DRY_RUN_SET.has(channelId)) return createDryRunAdapter(channelId, opts.runId);
  throw new Error(`unknown channel: ${channelId} (F2 supports: ${DRY_RUN_CHANNELS.join(', ')})`);
}

/** F2 back-compat: dry-run resolution for a channel id + run id. */
export function resolveChannelAdapter(channelId: string, runId: string): ChannelAdapter {
  return resolveAdapter(channelId, { publishMode: 'dry-run', runId });
}
