/**
 * planTaskGraph's DEFAULT LLM transport (createDefaultLlmClient, internal to
 * planner.ts — exercised here via planTaskGraph without an injected
 * llmClient, with `fetch` mocked).
 *
 * Regression coverage for a real failure: "kraken planner: failed to
 * produce a valid task graph after 2 attempts — Empty model response" on a
 * long/complex prompt against a reasoning-capable model. Root cause: a
 * 4096 max_tokens ceiling let the model exhaust its budget on
 * chain-of-thought (reasoning_content) before ever emitting the JSON
 * answer in `message.content`, and the retry loop couldn't help since it
 * repeats the same truncation. Fixed by raising the default budget
 * (configurable via ZELARI_KRAKEN_PLANNER_MAX_TOKENS), falling back to a
 * JSON object found inside `reasoning_content` when `content` is empty,
 * and surfacing `finish_reason` in the error when both are empty.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/cli/providerConfig.js', () => ({
  getProviderConfig: vi.fn(() => ({ activeProviderId: 'deepseek' })),
  getModelForProvider: vi.fn(() => 'deepseek-v4-flash'),
}));

vi.mock('../../src/cli/keyStore.js', () => ({
  resolveApiKeyWithMeta: vi.fn(async () => ({ apiKey: 'test-key' })),
}));

vi.mock('../../src/cli/provider/openai-compatible.js', () => ({
  resolveBaseUrl: vi.fn(() => 'https://api.deepseek.test/v1'),
}));

import { planTaskGraph } from '../../src/cli/kraken/planner.js';

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

const VALID_GRAPH_JSON = JSON.stringify({
  nodes: [{ id: 'e1', kind: 'explore', label: 'research', prompt: 'find stuff', deps: [] }],
});

describe('planTaskGraph — default LLM transport', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    delete process.env.ZELARI_KRAKEN_PLANNER_MAX_TOKENS;
    delete process.env.ZELARI_KRAKEN_PLANNER_TIMEOUT_MS;
    delete process.env.ZELARI_KRAKEN_PLANNER_MODEL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ZELARI_KRAKEN_PLANNER_TIMEOUT_MS;
    delete process.env.ZELARI_KRAKEN_PLANNER_MODEL;
  });

  it('sends a generous default max_tokens so a reasoning-heavy response is not truncated', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: VALID_GRAPH_JSON } }] }),
    );

    await planTaskGraph({ prompt: 'build a complex naval game with an ocean shader' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.max_tokens).toBeGreaterThanOrEqual(8192);
  });

  it('respects ZELARI_KRAKEN_PLANNER_MAX_TOKENS when set', async () => {
    process.env.ZELARI_KRAKEN_PLANNER_MAX_TOKENS = '16000';
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: VALID_GRAPH_JSON } }] }),
    );

    await planTaskGraph({ prompt: 'goal' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.max_tokens).toBe(16000);
  });

  it('falls back to a JSON object found inside reasoning_content when content is empty', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              content: '',
              reasoning_content: `Let me think about this... ${VALID_GRAPH_JSON}`,
            },
            finish_reason: 'length',
          },
        ],
      }),
    );

    const graph = await planTaskGraph({ prompt: 'goal' });

    expect(graph.nodes.has('e1')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // recovered without needing a retry
  });

  it('surfaces finish_reason in the error when both content and reasoning_content are empty', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: {}, finish_reason: 'length' }] }),
    );

    await expect(planTaskGraph({ prompt: 'goal' })).rejects.toThrow(/finish_reason=length/);
    expect(fetchMock).toHaveBeenCalledTimes(2); // both attempts exhausted
  });
});

/**
 * Regression coverage for the follow-on failure to the max_tokens fix above:
 * "failed to produce a valid task graph after 2 attempts — This operation was
 * aborted". The raw undici AbortError came from a hardcoded 90s ceiling that
 * a slow reasoning model blew past on a non-streaming request; the retry then
 * burned another 90s re-asking with an even longer prompt.
 */
describe('planTaskGraph — transport failures', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    delete process.env.ZELARI_KRAKEN_PLANNER_TIMEOUT_MS;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ZELARI_KRAKEN_PLANNER_TIMEOUT_MS;
  });

  it('fails once with an actionable message when the request times out', async () => {
    process.env.ZELARI_KRAKEN_PLANNER_TIMEOUT_MS = '5';
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new Error('This operation was aborted')),
          );
        }),
    );

    await expect(planTaskGraph({ prompt: 'goal' })).rejects.toThrow(
      /timed out after 0s[\s\S]*ZELARI_KRAKEN_PLANNER_TIMEOUT_MS/,
    );
    // No wasted second attempt: the model never answered the first one.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry an HTTP error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'upstream exploded' }, false));

    await expect(planTaskGraph({ prompt: 'goal' })).rejects.toThrow(/LLM HTTP 500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still retries a malformed-but-received response', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'not json' } }] }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: VALID_GRAPH_JSON } }] }));

    const graph = await planTaskGraph({ prompt: 'goal' });

    expect(graph.nodes.has('e1')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('disables the timer when ZELARI_KRAKEN_PLANNER_TIMEOUT_MS=0', async () => {
    process.env.ZELARI_KRAKEN_PLANNER_TIMEOUT_MS = '0';
    let seenSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (_url: string, init: { signal: AbortSignal }) => {
      seenSignal = init.signal;
      return jsonResponse({ choices: [{ message: { content: VALID_GRAPH_JSON } }] });
    });

    await planTaskGraph({ prompt: 'goal' });

    expect(seenSignal?.aborted).toBe(false);
  });
});

describe('planTaskGraph — planner model selection', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: VALID_GRAPH_JSON } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    delete process.env.ZELARI_KRAKEN_PLANNER_MODEL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ZELARI_KRAKEN_PLANNER_MODEL;
  });

  it('uses the persisted provider model by default', async () => {
    await planTaskGraph({ prompt: 'goal' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.model).toBe('deepseek-v4-flash');
  });

  it('prefers ZELARI_KRAKEN_PLANNER_MODEL over the persisted default', async () => {
    process.env.ZELARI_KRAKEN_PLANNER_MODEL = 'deepseek-v4-lite';

    await planTaskGraph({ prompt: 'goal' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.model).toBe('deepseek-v4-lite');
  });

  it("lets an explicit caller override win over the planner env", async () => {
    process.env.ZELARI_KRAKEN_PLANNER_MODEL = 'deepseek-v4-lite';

    await planTaskGraph({ prompt: 'goal', model: 'deepseek-v4-pro' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.model).toBe('deepseek-v4-pro');
  });
});
