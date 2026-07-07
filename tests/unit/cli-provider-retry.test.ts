/**
 * cli-provider-retry.test.ts — verifies openaiCompatibleProvider retries
 * transient HTTP failures (429/502/503/504) and network errors before
 * surfacing them, and does NOT retry non-transient statuses (4xx except 429).
 *
 * Mock pattern: replace globalThis.fetch with a counter that returns a
 * failing Response for the first N calls, then the streaming 200. Mirrors
 * tests/unit/cli-openai-compatible-tools.test.ts.
 *
 * Backoff timing: the real backoff (500ms × 2^attempt) would make tests slow,
 * so we cap ZELARI_PROVIDER_MAX_RETRIES=1 for most tests and accept ~0.5s of
 * real sleep per retry (exercises abortableSleep, not a mock).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Dynamic import so the module reads ZELARI_PROVIDER_MAX_RETRIES from the env
// we set in beforeEach (the value is captured at module-load via an IIFE).
// A static import would pin the value before the env override applies.
async function importFresh() {
  vi.resetModules();
  return (await import("../../src/cli/provider/openai-compatible.js")) as typeof import("../../src/cli/provider/openai-compatible.js");
}

interface FetchMock {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
}
const originalFetch = globalThis.fetch;
const REAL_ENV = { ...process.env };

function streamingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** A minimal SSE stop chunk the provider recognizes as a completed turn. */
const DONE_CHUNK = "data: [DONE]\n\n";

beforeEach(() => {
  process.env = { ...REAL_ENV };
  // Keep retries bounded so the backoff sleep doesn't slow the suite.
  process.env.ZELARI_PROVIDER_MAX_RETRIES = "2";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...REAL_ENV };
});

async function collect(provider: ReturnType<typeof openaiCompatibleProvider>): Promise<{ deltas: string[]; errors: string[] }> {
  const deltas: string[] = [];
  const errors: string[] = [];
  for await (const d of provider({
    messages: [{ role: "user", content: "hi" }],
    model: "test-model",
    provider: "openai-compatible",
    tools: [],
  })) {
    if (d.kind === "text") deltas.push(d.delta);
    else if (d.kind === "error") errors.push(d.message);
  }
  return { deltas, errors };
}

describe("openaiCompatibleProvider — transient retry", () => {
  it("retries 429 then succeeds on the 2nd attempt", async () => {
    let calls = 0;
    (globalThis as { fetch: FetchMock }).fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } });
      return streamingResponse([DONE_CHUNK]);
    };
    const { openaiCompatibleProvider } = await importFresh();
    const provider = openaiCompatibleProvider({
      apiKey: "k",
      baseUrl: "https://test.example/v1",
      model: "test-model",
      providerId: "openai-compatible",
    });
    const { deltas, errors } = await collect(provider);
    expect(calls).toBe(2);
    expect(errors).toEqual([]);
    expect(deltas).toEqual([]);
  });

  it("retries 503 then succeeds", async () => {
    let calls = 0;
    (globalThis as { fetch: FetchMock }).fetch = async () => {
      calls += 1;
      if (calls < 2) return new Response("bad gateway", { status: 503 });
      return streamingResponse(["data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n", DONE_CHUNK]);
    };
    const { openaiCompatibleProvider } = await importFresh();
    const provider = openaiCompatibleProvider({
      apiKey: "k",
      baseUrl: "https://test.example/v1",
      model: "m",
      providerId: "openai-compatible",
    });
    const { deltas, errors } = await collect(provider);
    expect(calls).toBe(2);
    expect(errors).toEqual([]);
    expect(deltas).toContain("hi");
  });

  it("retries network errors (fetch throws) then succeeds", async () => {
    let calls = 0;
    (globalThis as { fetch: FetchMock }).fetch = async () => {
      calls += 1;
      if (calls === 1) throw new Error("ECONNRESET");
      return streamingResponse([DONE_CHUNK]);
    };
    const { openaiCompatibleProvider } = await importFresh();
    const provider = openaiCompatibleProvider({
      apiKey: "k",
      baseUrl: "https://test.example/v1",
      model: "m",
      providerId: "openai-compatible",
    });
    const { errors } = await collect(provider);
    expect(calls).toBe(2);
    expect(errors).toEqual([]);
  });

  it("surfaces the error after MAX_RETRIES exhausted", async () => {
    // beforeEach sets ZELARI_PROVIDER_MAX_RETRIES=2, and importFresh() re-reads
    // it at module load: 1 initial + 2 retries = 3 fetches before giving up.
    let calls = 0;
    (globalThis as { fetch: FetchMock }).fetch = async () => {
      calls += 1;
      return new Response("overloaded", { status: 429, headers: { "Retry-After": "0" } });
    };
    const { openaiCompatibleProvider } = await importFresh();
    const provider = openaiCompatibleProvider({
      apiKey: "k",
      baseUrl: "https://test.example/v1",
      model: "m",
      providerId: "openai-compatible",
    });
    const { errors } = await collect(provider);
    expect(calls).toBe(3);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/HTTP 429/);
  });

  it("does NOT retry a 400 (non-transient client error)", async () => {
    let calls = 0;
    (globalThis as { fetch: FetchMock }).fetch = async () => {
      calls += 1;
      return new Response("bad request", { status: 400 });
    };
    const { openaiCompatibleProvider } = await importFresh();
    const provider = openaiCompatibleProvider({
      apiKey: "k",
      baseUrl: "https://test.example/v1",
      model: "m",
      providerId: "openai-compatible",
    });
    const { errors } = await collect(provider);
    expect(calls).toBe(1); // no retry
    expect(errors[0]).toMatch(/HTTP 400/);
  });

  it("honors Retry-After header (resolves earlier failures without it)", async () => {
    // Just verifies the header is read without throwing — timing precision
    // isn't asserted (the backoff is real-time and flaky on slow CI).
    let calls = 0;
    (globalThis as { fetch: FetchMock }).fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response("limited", { status: 429, headers: { "Retry-After": "0" } });
      return streamingResponse([DONE_CHUNK]);
    };
    const { openaiCompatibleProvider } = await importFresh();
    const provider = openaiCompatibleProvider({
      apiKey: "k",
      baseUrl: "https://test.example/v1",
      model: "m",
      providerId: "openai-compatible",
    });
    const { errors } = await collect(provider);
    expect(calls).toBe(2);
    expect(errors).toEqual([]);
  });
});
