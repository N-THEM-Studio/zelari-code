/**
 * streamScrub — incremental scrubber for streamed assistant text.
 *
 * The TUI (`useChatTurn`) cleans `<think>`/`---QUESTION---` blocks from the
 * live bubble by re-running `cleanAgentContent` over the WHOLE accumulated
 * text on every delta and diffing against the previous clean snapshot.
 *
 * The headless path (`runHeadless*`) used to emit `event.delta` raw, so
 * `<think>` tags (GLM/MiniMax) and `---QUESTION---` clarification blocks
 * leaked into the desktop UI. This module ports the same incremental-clean
 * pattern so headless JSON consumers only ever see scrubbed text.
 *
 * Why accumulate: a `<think>` tag can be split across several deltas, so a
 * per-chunk regex can't tell "opening tag just started" from "tag closed".
 * We keep the raw tail, clean the whole thing, and return only the newly
 * stable suffix.
 *
 * @since v1.10.0
 */

import { cleanAgentContent } from '@zelari/core';

/**
 * Create a stateful scrubber. Feed it each raw `message_delta` chunk; it
 * returns the portion that is safe to display (the delta of the cleaned
 * text since the last call).
 *
 * Call {@link StreamScrubber.flush} at end-of-turn to drop any trailing
 * unclosed `<think>` block that never got its closing tag.
 */
export interface StreamScrubber {
  /** Feed a raw chunk; get back the clean delta to display/emit. */
  push(rawDelta: string): string;
  /** End of turn: return any remaining cleaned text (handles unclosed tags). */
  flush(): string;
  /**
   * Reset internal state for a new assistant message. In a tool-loop turn the
   * harness emits multiple `message_start` → `message_delta*` → `message_end`
   * cycles (one per assistant turn). Without a reset, an unclosed `<think>`
   * tag in an early message makes the trailing-block regex (`/<think>[\s\S]*$/`)
   * eat ALL subsequent text across later messages — so legitimate prose between
   * tool calls gets trapped and never emitted. Call this on every message_start.
   */
  reset(): void;
}

export function createStreamScrubber(): StreamScrubber {
  let rawBuf = '';
  let emittedLen = 0;

  const snapshot = (): string => {
    // cleanAgentContent strips complete + unclosed <think> blocks, orphan
    // closing tags, minimax wrappers, and (by default) ---QUESTION--- blocks.
    const cleaned = cleanAgentContent(rawBuf);
    if (cleaned.length <= emittedLen) return '';
    const delta = cleaned.slice(emittedLen);
    emittedLen = cleaned.length;
    return delta;
  };

  return {
    push(rawDelta: string): string {
      rawBuf += rawDelta;
      return snapshot();
    },
    flush(): string {
      // Force-strip any trailing unclosed <think> by re-cleaning; if the
      // accumulated raw never closed its tag, cleanAgentContent already
      // drops it via the `/<think[^>]*>[\s\S]*$/` rule, so snapshot() above
      // already returned '' for it. Flush is a safety net for edge cases
      // (e.g. content trimmed in odd ways) — re-snapshot once more.
      return snapshot();
    },
    reset(): void {
      // New assistant message: drop the raw accumulator so an unclosed
      // <think> in a previous message can't swallow this one's text.
      rawBuf = '';
      emittedLen = 0;
    },
  };
}
