// @vitest-environment jsdom
/**
 * cli-chatState.test.ts — v0.7.0 finalized/live state transitions.
 *
 * Covers the design invariant of the static-scrollback TUI:
 *   **A message enters `finalized` only when it can never change again.**
 *
 *   - system/user: final immediately.
 *   - assistant streaming: final on finalizeStreaming() (the seal point).
 *   - tool: final on completeTool() (tool_execution_end), NOT on startTool.
 *
 * Assertions are by identity where possible: finalized items must NEVER be
 * mutated in place after they land (Static items are immutable).
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useState } from 'react';
import type { ChatMessage } from '../../src/cli/components/ChatStream.js';
import {
  EMPTY_LIVE,
  setStreaming,
  finalizeStreaming,
  startTool,
  completeTool,
  pushFinalized,
  type LiveState,
} from '../../src/cli/hooks/chatState.js';

/** Test harness mirroring how useSession composes finalized + live state. */
function useTestState() {
  const [finalized, setFinalized] = useState<ChatMessage[]>([]);
  const [live, setLive] = useState<LiveState>(EMPTY_LIVE);
  return { finalized, setFinalized, live, setLive };
}

const sys = (id: string, content: string): ChatMessage => ({
  id,
  role: 'system',
  content,
  ts: 0,
});

describe('chatState — finalized/live split (v0.7.0)', () => {
  it('system/user messages are final immediately (pushFinalized)', () => {
    const { result } = renderHook(() => useTestState());
    act(() => {
      pushFinalized(result.current.setFinalized, sys('s1', 'hello'));
    });
    expect(result.current.finalized).toHaveLength(1);
    expect(result.current.finalized[0].id).toBe('s1');
    // live region untouched.
    expect(result.current.live.streaming).toBeNull();
    expect(result.current.live.runningTools).toHaveLength(0);
  });

  it('streaming bubble lives in live, NOT finalized, while streaming', () => {
    const { result } = renderHook(() => useTestState());
    act(() => {
      setStreaming(result.current.setLive, 'parti', 10);
      setStreaming(result.current.setLive, 'partial answer', 11);
    });
    // Still streaming → finalized empty, live.streaming populated.
    expect(result.current.finalized).toHaveLength(0);
    expect(result.current.live.streaming).not.toBeNull();
    expect(result.current.live.streaming!.content).toBe('partial answer');
    expect(result.current.live.streaming!.id.startsWith('streaming-')).toBe(true);
  });

  it('finalizeStreaming moves the bubble into finalized and clears live (seal point)', () => {
    const { result } = renderHook(() => useTestState());
    act(() => {
      setStreaming(result.current.setLive, 'full answer', 10);
    });
    act(() => {
      finalizeStreaming(result.current.setFinalized, result.current.setLive);
    });
    // Sealed: finalized has it, live.streaming cleared.
    expect(result.current.finalized).toHaveLength(1);
    expect(result.current.finalized[0].content).toBe('full answer');
    // The streaming- prefix is dropped on seal (fresh bubble next turn).
    expect(result.current.finalized[0].id.startsWith('streaming-')).toBe(false);
    expect(result.current.live.streaming).toBeNull();
  });

  it('finalizeStreaming is a no-op when nothing is streaming (idempotent)', () => {
    const { result } = renderHook(() => useTestState());
    act(() => {
      finalizeStreaming(result.current.setFinalized, result.current.setLive);
    });
    expect(result.current.finalized).toHaveLength(0);
  });

  it('tool start stays in live.runningTools; it does NOT enter finalized', () => {
    const { result } = renderHook(() => useTestState());
    act(() => {
      startTool(result.current.setLive, 'bash', 'call-1', { cmd: 'ls' }, 100);
    });
    expect(result.current.live.runningTools).toHaveLength(1);
    expect(result.current.live.runningTools[0].toolCallId).toBe('call-1');
    expect(result.current.live.runningTools[0].toolOk).toBeUndefined();
    // Invariant: NOT finalized yet (could still mutate).
    expect(result.current.finalized).toHaveLength(0);
  });

  it('completeTool moves the tool into finalized with result + status, removes from live', () => {
    const { result } = renderHook(() => useTestState());
    act(() => {
      startTool(result.current.setLive, 'bash', 'call-1', { cmd: 'ls' }, 100);
    });
    act(() => {
      completeTool(
        result.current.live,
        result.current.setFinalized,
        result.current.setLive,
        'call-1',
        false, // isError
        42,
        'file1\nfile2',
      );
    });
    // Tool finalized with body + ok status.
    expect(result.current.finalized).toHaveLength(1);
    expect(result.current.finalized[0].role).toBe('tool');
    expect(result.current.finalized[0].toolOk).toBe(true);
    expect(result.current.finalized[0].toolDurationMs).toBe(42);
    expect(result.current.finalized[0].toolResult).toBe('file1\nfile2');
    // Removed from live.
    expect(result.current.live.runningTools).toHaveLength(0);
  });

  it('completeTool is a no-op for an unknown toolCallId (defensive against dup end events)', () => {
    const { result } = renderHook(() => useTestState());
    act(() => {
      completeTool(
        result.current.live,
        result.current.setFinalized,
        result.current.setLive,
        'never-started',
        false,
        1,
        'x',
      );
    });
    expect(result.current.finalized).toHaveLength(0);
    expect(result.current.live.runningTools).toHaveLength(0);
  });

  it('multiple pending tools coexist in live and finalize independently', () => {
    const { result } = renderHook(() => useTestState());
    act(() => {
      startTool(result.current.setLive, 'bash', 'c1', {}, 1);
      startTool(result.current.setLive, 'grep', 'c2', {}, 2);
    });
    expect(result.current.live.runningTools).toHaveLength(2);
    // Finalize the second one first (out of order).
    act(() => {
      completeTool(result.current.live, result.current.setFinalized, result.current.setLive, 'c2', false, 5, 'match');
    });
    expect(result.current.finalized).toHaveLength(1);
    expect(result.current.finalized[0].toolCallId).toBe('c2');
    expect(result.current.live.runningTools).toHaveLength(1);
    expect(result.current.live.runningTools[0].toolCallId).toBe('c1');
  });

  it('council: same-member streaming extends; different-member creates a new bubble', () => {
    const { result } = renderHook(() => useTestState());
    act(() => {
      setStreaming(result.current.setLive, 'Caronte part 1', 1, { memberId: 'charont', memberName: 'Caronte' });
    });
    act(() => {
      setStreaming(result.current.setLive, 'Caronte part 2', 2, { memberId: 'charont', memberName: 'Caronte' });
    });
    // Same member → content replaced (extended).
    expect(result.current.live.streaming!.content).toBe('Caronte part 2');
    const firstId = result.current.live.streaming!.id;

    act(() => {
      setStreaming(result.current.setLive, 'Nettuno speaks', 3, { memberId: 'nettun', memberName: 'Nettuno' });
    });
    // Different member → new bubble (different id), content is the new member's.
    expect(result.current.live.streaming!.content).toBe('Nettuno speaks');
    expect(result.current.live.streaming!.id).not.toBe(firstId);
    expect(result.current.live.streaming!.memberName).toBe('Nettuno');
  });
});

describe('chatState — finalized immutability (Static contract)', () => {
  it('a finalized assistant message is not mutated by a later streaming cycle', () => {
    const { result } = renderHook(() => useTestState());
    act(() => {
      setStreaming(result.current.setLive, 'turn 1 answer', 10);
      finalizeStreaming(result.current.setFinalized, result.current.setLive);
    });
    const sealed = result.current.finalized[0];
    const sealedContent = sealed.content;
    const sealedId = sealed.id;
    // New streaming cycle for turn 2.
    act(() => {
      setStreaming(result.current.setLive, 'turn 2 answer', 20);
    });
    // The previously finalized message is untouched.
    expect(result.current.finalized[0].content).toBe(sealedContent);
    expect(result.current.finalized[0].id).toBe(sealedId);
    expect(result.current.finalized).toHaveLength(1);
    expect(result.current.live.streaming!.content).toBe('turn 2 answer');
  });
});
