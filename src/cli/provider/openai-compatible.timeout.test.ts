import { describe, it, expect } from 'vitest';
import { readChunkWithTimeout } from './openai-compatible.js';

/**
 * Regression: the stream idle timeout used to reset on EVERY network chunk,
 * including SSE keep-alive frames that carry no content (blank lines, `: ping`,
 * `data:` with no choices). A stalled model behind a keep-alive gateway looked
 * "alive" forever: process hung 20+ min with an ESTABLISHED socket and zero
 * tokens, and the 5-min idle timeout never fired because keep-alives kept
 * resetting it. The idle budget now measures silence since the last *useful*
 * delta (text/thinking/tool_call/usage), so keep-alives cannot mask a stall.
 */

function makeStream(
  chunk: string,
): { reader: ReadableStreamDefaultReader<Uint8Array>; stop: () => void } {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Controller already closed (reader cancelled) — stop the timer.
          if (timer) clearInterval(timer);
        }
      }, 10);
    },
  });
  return {
    reader: stream.getReader(),
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}

describe('readChunkWithTimeout idle budget', () => {
  it('fires idle timeout even when keep-alive frames keep arriving (no content)', async () => {
    const { reader, stop } = makeStream(':\n\n'); // SSE comment = keep-alive
    const lastUsefulAt = Date.now() - 5_000; // last useful delta 5s ago
    const deadline = Date.now() + 30_000;

    const started = Date.now();
    await expect(
      readChunkWithTimeout(reader, {
        idleMs: 2_000,
        deadlineMs: deadline,
        lastUsefulAt: () => lastUsefulAt,
      }),
    ).rejects.toThrow(/idle/);

    // The timeout must fire promptly (not wait for the absolute deadline),
    // because the idle budget is already exhausted.
    expect(Date.now() - started).toBeLessThan(1_000);
    await reader.cancel('test done');
    stop();
  });

  it('does NOT fire idle when useful content keeps the budget fresh', async () => {
    const { reader, stop } = makeStream(
      'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
    );

    let lastUsefulAt = Date.now();
    // Read 3 chunks; with each chunk the caller would markUseful(), so the
    // idle budget never runs out. A single read returns the chunk.
    for (let i = 0; i < 3; i += 1) {
      const res = await readChunkWithTimeout(reader, {
        idleMs: 2_000,
        deadlineMs: Date.now() + 30_000,
        lastUsefulAt: () => lastUsefulAt,
      });
      expect(res.done).toBe(false);
      lastUsefulAt = Date.now(); // simulate markUseful()
    }
    await reader.cancel('test done');
    stop();
  });
});
