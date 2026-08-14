/**
 * streamScrub — throttle cleanAgentContent to the TUI commit cadence.
 *
 * cleanAgentContent runs ~35 regexes over the full accumulated buffer.
 * Streaming at 50–200 deltas/sec made that quadratic. The render path is
 * already capped at 16ms, so scrubbing faster than that cannot be seen.
 *
 * Callers accumulate raw text and pass it here; `next()` re-scrubs at most
 * once per interval. `finalize()` always scrubs the current buffer so the
 * last tokens of a message are not dropped when the last deltas fell inside
 * the throttle window.
 */
import { cleanAgentContent } from '@zelari/core';

export const STREAM_SCRUB_INTERVAL_MS = 16;

export interface StreamScrubber {
  next(raw: string, now?: number): string;
  finalize(raw: string): string;
  reset(): void;
}

export function createStreamScrubber(
  intervalMs: number = STREAM_SCRUB_INTERVAL_MS,
): StreamScrubber {
  let lastAt = 0;
  let lastScrubbed: string | null = null;

  return {
    next(raw: string, now: number = Date.now()): string {
      if (lastScrubbed === null || now - lastAt >= intervalMs) {
        lastAt = now;
        lastScrubbed = cleanAgentContent(raw);
      }
      return lastScrubbed;
    },
    finalize(raw: string): string {
      lastScrubbed = cleanAgentContent(raw);
      lastAt = Date.now();
      return lastScrubbed;
    },
    reset(): void {
      lastScrubbed = null;
      lastAt = 0;
    },
  };
}
