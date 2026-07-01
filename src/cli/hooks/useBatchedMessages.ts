import { useCallback, useEffect, useRef } from 'react';
import type { ChatMessage } from '../components/ChatStream.js';

/**
 * useBatchedMessages — leading+trailing throttle layer over the chat `messages`
 * state, built to kill per-token TUI flicker.
 *
 * Why this exists: the LLM emits ~50-200 `message_delta` events/sec during
 * streaming. Each used to call `setMessages` directly, producing a fresh
 * array identity on every token. That defeated `React.memo(ChatStream)` (its
 * `useMemo` depends on the `messages` reference) and forced a full repaint of
 * the whole message tree 50-200 times/sec — visible as flicker.
 *
 * Design: a throttle with **leading + trailing** edges, capped at one commit
 * per `cadenceMs` (default 16ms ≈ 60fps):
 *   - Leading edge: the FIRST commit in a quiet period flushes immediately, so
 *     the first streaming character appears with no latency.
 *   - Trailing edge: commits that arrive during the throttle window are
 *     composed into a single functional updater and applied in ONE render
 *     when the window closes.
 *
 * Functional updaters are composed in arrival order (`f3 ∘ f2 ∘ f1`), so
 * intermediate state transitions are preserved exactly. Because the streaming
 * caller (`appendOrExtendStreamingAssistant`) always passes the *full*
 * accumulated content (not a delta), composing is both correct and lets later
 * commits supersede earlier ones naturally.
 *
 * Non-streaming calls (`/new` reset, bootstrap restore, system/error messages)
 * use the raw `setMessages` passthrough — they are rare and user-facing, so
 * they apply instantly. Only the streaming hot-path goes through `commit`.
 *
 * Throttle idiom mirrors `useTerminalSize`'s setTimeout-based coalesce so the
 * codebase stays consistent. No new dependencies.
 */
export interface UseBatchedMessagesResult {
  /** The committed (rendered) state. Read this for display. */
  messages: ChatMessage[];
  /**
   * Throttled setter for the streaming hot-path. Accepts the same signature
   * as a React state setter (functional updater or direct value). Buffered
   * and flushed at most once per `cadenceMs`. Call `flush()` to drain
   * synchronously (e.g. on stream end).
   */
  commit: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  /** Drain any pending buffered update to state immediately. Idempotent. */
  flush: () => void;
  /** Raw React setter — bypasses the throttle entirely. For non-streaming calls. */
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}

export function useBatchedMessages(
  messages: ChatMessage[],
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  cadenceMs: number = 16,
): UseBatchedMessagesResult {
  // Composed pending updater, or `null` when nothing is buffered.
  const pendingRef = useRef<React.SetStateAction<ChatMessage[]> | null>(null);
  // Active throttle-window timer handle, or `null` when not throttling.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Apply the current pending updater to state, ignoring/clearing the timer.
   * Used as the synchronous public drain (stream end) and internally.
   */
  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending !== null) {
      setMessages(pending);
    }
  }, [setMessages]);

  const commit = useCallback(
    (update: React.SetStateAction<ChatMessage[]>) => {
      // Compose this update onto any pending one, preserving arrival order.
      const head = pendingRef.current;
      pendingRef.current =
        head === null
          ? update
          : (state: ChatMessage[]) => {
              const intermediate = typeof head === 'function' ? head(state) : head;
              return typeof update === 'function' ? update(intermediate) : update;
            };

      if (timerRef.current === null) {
        // Leading edge: not currently throttling. Flush immediately so the
        // first token renders with no latency, then open a throttle window.
        const leading = pendingRef.current;
        pendingRef.current = null;
        if (leading !== null) {
          setMessages(leading);
        }
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          // Trailing edge: flush anything that accumulated during the window
          // as a single render. Do NOT re-arm — the next commit starts a new
          // leading edge.
          const tail = pendingRef.current;
          pendingRef.current = null;
          if (tail !== null) {
            setMessages(tail);
          }
        }, cadenceMs);
      }
      // else: inside a throttle window — the trailing handler above will
      // catch the buffered update when the window closes.
    },
    [cadenceMs, setMessages],
  );

  // On unmount: cancel any pending timer. Do NOT flush — teardown means the
  // display is going away, and persisted state lives in the JSONL writer.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return { messages, commit, flush, setMessages };
}
