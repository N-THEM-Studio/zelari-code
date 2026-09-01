import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';

/**
 * Adapter-level timeout regressions (anthropic + chatgpt).
 *
 * Both adapters used to fetch with only `params.signal` and loop
 * `await reader.read()` with no watchdog: blocked egress (no response
 * headers) or a stalled model behind a keep-alive gateway hung the turn
 * forever. They now share the openai-compatible.ts policy:
 *   - CONNECT: wall clock until response headers (ZELARI_PROVIDER_CONNECT_TIMEOUT_MS)
 *   - IDLE: silence since the last USEFUL event (pings/keep-alives don't count)
 *   - MAX: absolute cap on one stream (ZELARI_PROVIDER_STREAM_MAX_MS)
 *
 * Env minimums are clamped inside openai-compatible.ts (connect >= 5s,
 * idle >= 15s, max >= 60s; lower values fall back to the defaults), and the
 * constants are IIFEs evaluated at module load — so the env must be set
 * BEFORE the dynamic import below. Because short real timeouts are not
 * reachable through the adapters, these tests use vitest fake timers to
 * advance virtual time through the clamped minimums instantly.
 */

// Set before the dynamic import: the PROVIDER_* constants are load-time IIFEs.
process.env.ZELARI_PROVIDER_CONNECT_TIMEOUT_MS = '5000';
process.env.ZELARI_PROVIDER_STREAM_IDLE_MS = '15000';
process.env.ZELARI_PROVIDER_STREAM_MAX_MS = '60000';

const { anthropicMessagesProvider } = await import('./anthropic.js');
const { chatgptResponsesProvider } = await import('./chatgpt.js');

const ORIGINAL_ENV = { ...process.env };

type AdapterConfig = Parameters<typeof anthropicMessagesProvider>[0];
type StreamParams = Parameters<ReturnType<typeof anthropicMessagesProvider>>[0];

const baseConfig: AdapterConfig = {
  apiKey: 'test-key',
  baseUrl: 'https://provider.test/v1',
  model: 'test-model',
  providerId: 'anthropic',
};

const params: StreamParams = {
  messages: [],
  model: 'test-model',
  provider: 'anthropic',
  tools: [],
};

/** Fetch stub that never resolves, but honors abort like real fetch does. */
function neverRespondingFetch(): typeof fetch {
  return ((_url: string | URL, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
}

/** 200 OK whose SSE body never yields a single byte (stalled gateway). */
function stalledBodyFetch(): typeof fetch {
  return (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start() {
          // Never enqueue, never close.
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )) as unknown as typeof fetch;
}

describe('provider adapter timeouts', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('connect timeout (headers never arrive)', () => {
    it('anthropic: surfaces the connect timeout as an error delta', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', neverRespondingFetch());

      const gen = anthropicMessagesProvider(baseConfig)(params);
      const first = gen.next(); // runs until the (pending) fetch
      await vi.advanceTimersByTimeAsync(5_100);

      const res = await first;
      expect(res.value).toMatchObject({ kind: 'error' });
      expect((res.value as { message: string }).message).toContain('connect timeout');
    });

    it('chatgpt: surfaces the connect timeout as an error delta', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', neverRespondingFetch());

      const gen = chatgptResponsesProvider({ ...baseConfig, providerId: 'chatgpt' })(params);
      const first = gen.next();
      await vi.advanceTimersByTimeAsync(5_100);

      const res = await first;
      expect(res.value).toMatchObject({ kind: 'error' });
      expect((res.value as { message: string }).message).toContain('connect timeout');
    });
  });

  describe('stream idle timeout (anthropic)', () => {
    it('fires when the body never yields any event', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', stalledBodyFetch());

      const gen = anthropicMessagesProvider(baseConfig)(params);
      const first = gen.next(); // runs until the first (pending) read
      // Attach the rejection handler BEFORE advancing time: the idle error
      // fires mid-advance, and a rejected promise without a handler inside
      // the fake-timer tick would surface as an unhandled rejection.
      const expectation = expect(first).rejects.toThrow(/idle/);
      await vi.advanceTimersByTimeAsync(16_000);
      await expectation;
    });

    it('fires even when SSE ping keep-alives keep arriving (no useful events)', async () => {
      vi.useFakeTimers();
      const encoder = new TextEncoder();
      let timer: ReturnType<typeof setInterval> | undefined;
      vi.stubGlobal(
        'fetch',
        (async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                timer = setInterval(() => {
                  try {
                    controller.enqueue(encoder.encode('event: ping\ndata: {"type":"ping"}\n\n'));
                  } catch {
                    // Controller already closed (reader released) — stop.
                    if (timer) clearInterval(timer);
                  }
                }, 10);
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          )) as unknown as typeof fetch,
      );

      const gen = anthropicMessagesProvider(baseConfig)(params);
      const first = gen.next();
      // Handler attached pre-advance (see the test above) so the mid-tick
      // rejection never becomes an unhandled rejection.
      const expectation = expect(first).rejects.toThrow(/idle/);
      await vi.advanceTimersByTimeAsync(16_000);
      await expectation;
    });
  });
});
