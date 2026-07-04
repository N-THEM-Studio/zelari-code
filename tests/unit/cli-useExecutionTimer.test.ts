// @vitest-environment jsdom
/**
 * cli-useExecutionTimer.test.ts — coverage for the StatusBar execution timer
 * (v0.7.9). The hook ticks while `busy` is true and freezes the duration of
 * the completed run into `lastMs` when `busy` drops back to false.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useExecutionTimer } from '../../src/cli/hooks/useExecutionTimer.js';

describe('useExecutionTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is idle before the first run', () => {
    const { result } = renderHook(() => useExecutionTimer(false));
    expect(result.current.elapsedMs).toBeNull();
    expect(result.current.lastMs).toBeNull();
  });

  it('starts at 0 and ticks while busy', () => {
    const { result, rerender } = renderHook(({ busy }) => useExecutionTimer(busy), {
      initialProps: { busy: false },
    });
    rerender({ busy: true });
    expect(result.current.elapsedMs).toBe(0);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.elapsedMs).toBeGreaterThanOrEqual(3000);
    expect(result.current.lastMs).toBeNull();
  });

  it('freezes the run duration into lastMs when busy ends', () => {
    const { result, rerender } = renderHook(({ busy }) => useExecutionTimer(busy), {
      initialProps: { busy: true },
    });
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    rerender({ busy: false });
    expect(result.current.elapsedMs).toBeNull();
    expect(result.current.lastMs).toBeGreaterThanOrEqual(5000);
  });

  it('a new run resets the elapsed counter', () => {
    const { result, rerender } = renderHook(({ busy }) => useExecutionTimer(busy), {
      initialProps: { busy: true },
    });
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    rerender({ busy: false });
    rerender({ busy: true });
    expect(result.current.elapsedMs).toBe(0);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.elapsedMs).toBeGreaterThanOrEqual(1000);
    expect(result.current.elapsedMs).toBeLessThan(4000);
  });
});
