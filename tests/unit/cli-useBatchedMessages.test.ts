// @vitest-environment jsdom
/**
 * cli-useBatchedMessages.test.ts — coverage for the streaming throttle layer.
 *
 * The LLM emits ~50-200 `message_delta` events/sec during streaming. Before
 * this hook, each event called `setMessages` directly, producing a fresh
 * array identity on every token and defeating `React.memo(ChatStream)` —
 * visible as TUI flicker. `useBatchedMessages` is a leading+trailing throttle
 * that caps commits at one per `cadenceMs` (default 16ms ≈ 60fps).
 *
 * These tests use fake timers to assert the throttle behavior deterministically.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useState, useRef, useCallback } from 'react';
import { useBatchedMessages } from '../../src/cli/hooks/useBatchedMessages.js';
import type { ChatMessage } from '../../src/cli/components/ChatStream.js';

/** Build a minimal ChatMessage for assertions. */
function msg(id: string, content: string): ChatMessage {
  return { id, role: 'assistant', content, ts: 0 };
}

/**
 * Wrapper that owns the real `useState<ChatMessage[]>` and wires it through
 * `useBatchedMessages`, mirroring how `useSession` composes the hook. A
 * ref-counted wrapper around `setMessages` counts how many times the
 * underlying React setter actually fired (i.e. committed renders). The
 * counter survives re-renders because it lives in a ref.
 */
function useHarness(cadenceMs?: number) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const commitCountRef = useRef(0);
  const wrappedSet = useCallback<React.Dispatch<React.SetStateAction<ChatMessage[]>>>(
    (update) => {
      commitCountRef.current++;
      setMessages(update);
    },
    [setMessages],
  );
  const batched = useBatchedMessages(messages, wrappedSet, cadenceMs);
  return { ...batched, messages, commitCount: commitCountRef.current };
}

describe('useBatchedMessages', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('leading edge: the first commit flushes immediately (no latency)', () => {
    const { result } = renderHook(() => useHarness(16));

    act(() => {
      result.current.commit(() => [msg('a', 'hello')]);
    });

    // Leading edge applies synchronously — no timer needed.
    expect(result.current.commitCount).toBe(1);
  });

  it('coalesces a burst of commits into a single trailing render', () => {
    const { result } = renderHook(() => useHarness(16));

    // First commit: leading edge (immediate flush).
    act(() => {
      result.current.commit(() => [msg('a', 'h')]);
    });
    expect(result.current.commitCount).toBe(1);

    // Burst of 4 more commits inside the throttle window — buffered, no flush.
    act(() => {
      result.current.commit(() => [msg('a', 'he')]);
      result.current.commit(() => [msg('a', 'hel')]);
      result.current.commit(() => [msg('a', 'hell')]);
      result.current.commit(() => [msg('a', 'hello')]);
    });
    // Still only the leading-edge call; the burst is coalesced.
    expect(result.current.commitCount).toBe(1);

    // Advance past the throttle window: ONE trailing flush fires.
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(result.current.commitCount).toBe(2);
  });

  it('flush() drains buffered updates synchronously and cancels the trailing timer', () => {
    const { result } = renderHook(() => useHarness(16));

    // Leading commit.
    act(() => {
      result.current.commit(() => [msg('a', 'h')]);
    });
    expect(result.current.commitCount).toBe(1);

    // Buffer a few more inside the window.
    act(() => {
      result.current.commit(() => [msg('a', 'he')]);
      result.current.commit(() => [msg('a', 'hel')]);
    });
    expect(result.current.commitCount).toBe(1);

    // flush() drains immediately.
    act(() => {
      result.current.flush();
    });
    expect(result.current.commitCount).toBe(2);

    // Advancing the timer must NOT fire a duplicate (flush cancelled it).
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current.commitCount).toBe(2);
  });

  it('flush() is idempotent when nothing is pending', () => {
    const { result } = renderHook(() => useHarness(16));

    act(() => {
      result.current.flush(); // no pending update
      result.current.flush(); // still nothing
    });

    expect(result.current.commitCount).toBe(0);
  });

  it('stream-end correctness: commit + immediate flush delivers final content', () => {
    // Guards the regression in cli-useChatTurn: a single delta followed by an
    // immediate agent_end must surface the final content, not drop it.
    const { result } = renderHook(() => useHarness(16));

    act(() => {
      result.current.commit(() => [msg('streaming-1', 'hello')]);
      result.current.flush();
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]?.content).toBe('hello');
  });

  it('non-streaming setMessages passthrough bypasses the throttle entirely', () => {
    const { result } = renderHook(() => useHarness(16));

    // Direct passthrough applies instantly, even during a throttle window.
    act(() => {
      result.current.commit(() => [msg('a', 'streaming')]); // opens a window
    });
    act(() => {
      result.current.setMessages(() => [msg('sys', 'system msg')]); // bypasses
    });

    expect(result.current.messages[0]?.content).toBe('system msg');
  });

  it('composed functional updaters preserve arrival order', () => {
    // Two commits inside a window: head then update. The composed fn must
    // apply head first, then update on the result.
    const { result } = renderHook(() => useHarness(16));

    act(() => {
      result.current.commit((prev) => [...prev, msg('1', 'one')]); // leading
    });
    act(() => {
      result.current.commit((prev) => [...prev, msg('2', 'two')]); // buffered
      result.current.commit((prev) => [...prev, msg('3', 'three')]); // buffered
    });
    act(() => {
      vi.advanceTimersByTime(16); // trailing flush
    });

    expect(result.current.messages.map((m) => m.content)).toEqual(['one', 'two', 'three']);
  });

  it('cancels the pending trailing timer on unmount without flushing', () => {
    const { result, unmount } = renderHook(() => useHarness(16));

    act(() => {
      result.current.commit(() => [msg('a', 'h')]); // leading + arms trailing
      result.current.commit(() => [msg('a', 'he')]); // buffers for trailing
    });
    const callsBefore = result.current.commitCount;

    unmount();

    // After unmount, advancing time must not throw (timer cancelled by effect
    // cleanup). We can't read commitCount post-unmount, so assert no throw.
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(callsBefore).toBeGreaterThanOrEqual(1);
  });
});
