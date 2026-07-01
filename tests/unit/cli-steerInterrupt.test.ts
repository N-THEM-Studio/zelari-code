import { describe, it, expect, vi } from 'vitest';
import { applySteerInterrupt } from '../../src/cli/hooks/steer.js';

describe('applySteerInterrupt (Task C.3.4 — app.tsx steer flow)', () => {
  it('with active harness: enqueues + cancels in the correct order, then notifies', async () => {
    const cancelOrder: string[] = [];
    const harness = {
      enqueue: vi.fn((t: string) => { cancelOrder.push(`enqueue:${t}`); }),
      cancel: vi.fn(() => { cancelOrder.push('cancel'); }),
      queueLength: 2,
    };
    const appendMessage = vi.fn();
    const setQueueCount = vi.fn();
    const dispatchPrompt = vi.fn(async () => {/* no-op */});

    await applySteerInterrupt({
      text: 'pivot to refactor',
      harness,
      appendMessage,
      setQueueCount,
      dispatchPrompt,
    });

    // 1) enqueue was called with the text
    expect(harness.enqueue).toHaveBeenCalledWith('pivot to refactor');
    // 2) cancel was called
    expect(harness.cancel).toHaveBeenCalled();
    // 3) order: enqueue THEN cancel
    expect(cancelOrder).toEqual(['enqueue:pivot to refactor', 'cancel']);
    // 4) setQueueCount notified with the harness queueLength
    expect(setQueueCount).toHaveBeenCalledWith(2);
    // 5) appendMessage called with confirmation
    expect(appendMessage).toHaveBeenCalledTimes(1);
    const msg = appendMessage.mock.calls[0][0] as string;
    expect(msg).toMatch(/cancelled current run/);
    expect(msg).toMatch(/pivot to refactor/);
    expect(msg).toMatch(/queue: 2/);
    // 6) dispatchPrompt NOT called (harness was active)
    expect(dispatchPrompt).not.toHaveBeenCalled();
  });

  it('without active harness (null): falls back to dispatchPrompt + notifies', async () => {
    const appendMessage = vi.fn();
    const setQueueCount = vi.fn();
    const dispatchPrompt = vi.fn(async () => {/* no-op */});

    await applySteerInterrupt({
      text: 'fresh prompt',
      harness: null,
      appendMessage,
      setQueueCount,
      dispatchPrompt,
    });

    expect(appendMessage).toHaveBeenCalledWith(
      '[steer --interrupt] no active run — dispatching as fresh prompt.',
    );
    expect(dispatchPrompt).toHaveBeenCalledWith('fresh prompt');
    expect(setQueueCount).not.toHaveBeenCalled();
  });

  it('multiple consecutive interrupts accumulate in the harness queue', async () => {
    let queueLen = 0;
    const harness = {
      enqueue: vi.fn((_t: string) => { queueLen++; }),
      cancel: vi.fn(),
      get queueLength() { return queueLen; },
    };
    const appendMessage = vi.fn();
    const setQueueCount = vi.fn();
    const dispatchPrompt = vi.fn(async () => {/* no-op */});

    await applySteerInterrupt({ text: 'one', harness, appendMessage, setQueueCount, dispatchPrompt });
    await applySteerInterrupt({ text: 'two', harness, appendMessage, setQueueCount, dispatchPrompt });

    expect(harness.enqueue).toHaveBeenCalledTimes(2);
    expect(harness.cancel).toHaveBeenCalledTimes(2);
    expect(setQueueCount).toHaveBeenNthCalledWith(1, 1);
    expect(setQueueCount).toHaveBeenNthCalledWith(2, 2);
  });

  it('cancel before enqueue would be wrong — verify our order is preserved', async () => {
    // Regression: if a future refactor swaps the order, the queue drain would
    // not pick up the new prompt. This test guards the documented ordering.
    const sequence: string[] = [];
    const harness = {
      enqueue: vi.fn((t: string) => { sequence.push(`E(${t})`); }),
      cancel: vi.fn(() => { sequence.push('C'); }),
      queueLength: 1,
    };
    await applySteerInterrupt({
      text: 'X',
      harness,
      appendMessage: () => {},
      setQueueCount: () => {},
      dispatchPrompt: async () => {},
    });
    expect(sequence).toEqual(['E(X)', 'C']);
  });

  it('does not throw when harness.enqueue/cancel throw (defensive)', async () => {
    const harness = {
      enqueue: vi.fn(() => { throw new Error('enqueue failed'); }),
      cancel: vi.fn(),
      queueLength: 0,
    };
    const appendMessage = vi.fn();
    const setQueueCount = vi.fn();
    const dispatchPrompt = vi.fn(async () => {/* no-op */});

    // We expect applySteerInterrupt to propagate the error (not swallow it).
    // The CLI caller can decide to handle it. The point of this test is that
    // the helper does not silently swallow infrastructure errors.
    await expect(
      applySteerInterrupt({
        text: 't',
        harness,
        appendMessage,
        setQueueCount,
        dispatchPrompt,
      }),
    ).rejects.toThrow('enqueue failed');
  });

  it('appendMessage is called exactly once per invocation', async () => {
    const harness = {
      enqueue: vi.fn(),
      cancel: vi.fn(),
      queueLength: 0,
    };
    const appendMessage = vi.fn();
    await applySteerInterrupt({
      text: 't',
      harness,
      appendMessage,
      setQueueCount: vi.fn(),
      dispatchPrompt: vi.fn(async () => {}),
    });
    expect(appendMessage).toHaveBeenCalledTimes(1);
  });
});