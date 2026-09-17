/**
 * automations/channels/dryRun.ts — the F2 DRY-RUN adapter (ADR-0037 §F2).
 *
 * Deterministic and side-effect-free: the same (channel, runId) always yields
 * the same postId/url, and the url contains `dry-run` so a human (or a test)
 * can tell a dry run apart from a real publish at a glance.
 */
import type { ChannelAdapter, ChannelPublishResult } from './types.js';

/** Build a DRY-RUN adapter for `channelId`, bound to one `runId`. */
export function createDryRunAdapter(channelId: string, runId: string): ChannelAdapter {
  return {
    id: channelId,
    async publish(): Promise<ChannelPublishResult> {
      return {
        postId: `dry-${channelId}-${runId}`,
        url: `https://dry-run.invalid/${channelId}/${runId}`,
        dryRun: true,
      };
    },
  };
}
